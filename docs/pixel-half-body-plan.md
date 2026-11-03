# 像素动态形象包（sprites）半身：可行性结论与实现方案

> 任务 T-2749 的调研交付（只调研、不改产品代码）。代码引用以已提交的 `HEAD 95aec96`（分支 `feat/vrm-motion-system`）为准，行号来自 `git show HEAD:<file>`。素材测量覆盖仓库里全部 15 个 `kind: "sprites"` 包、130 张图集、4680 帧。

## 0. 背景

形象包体系（`src/core/packs.js:29` `KINDS = ['sprites', 'pictures', 'rig', 'live2d', 'vrm']`）已经让 **VRM**（移动相机）和 **Live2D**（缩放模型并偏移）支持“全身 / 半身”取景，见 [half-body-mode.md](half-body-mode.md)。现有约定如下：

- **取景从哪来**：`src/core/framing.js:47` `resolveFraming(settings, characterId, look)` 依次看角色自己的选择 `settings.framings[id]`、形象包 `pack.json` 的 `framing`、全局 `settings.prefs.framing`。只有 `SUPPORTED_KINDS`（`framing.js:27`，目前是 `['vrm', 'live2d']`）里的 kind 才会真的变成 `mode: 'half'`，其余 kind 返回 `supported: false`，画面保持全身。
- **腰线**：`pack.json` 的 `halfBody.waist` 取 0.2–0.9，按身高计，头顶为 0、脚底为 1。`validatePack` 在 `packs.js:484` 校验这个字段，校验和 kind 无关，`resolveLook` 在 `packs.js:599` 把它带到 `look.halfBody` 上。没写时，VRM 用骨骼测量，Live2D 依次用 HitArea、眼睛、默认 55% 推断。
- **渲染接口**：figure 提供 `setFraming(mode, { instant })`（`live2d.js:281`、`vrm.js:416`）。切换时不重新加载素材，用 0.35 s 的 smoothstep 平滑过去。画布上写 `data-framing`、`data-cut`、`data-band`（`live2d.js:322–324`）。
- **桌宠窗口**：`app.js:63` `framingOf`，`app.js:64` `syncFraming()` 在设置变化时调用 `el.petFigure.setFraming(f.mode)`。触摸命中由 `app.js:1338` `artPoint` 处理：读到画布上 `data-framing="half"` 时，用 `PF.toFullBody`（`framing.js:199`）把 y 乘以 `cut`，换算回全身比例，再交给 `app.js:1371` `zoneAtClient` 查触摸区表。

目标：判断除 VRM / Live2D 外的三类（sprites、pictures、rig）能否半身。重点是 sprites，要给出能直接交给实现任务的设计。

## 1. 调研方法

1. **读代码**：上面列出的取景链路，加上 `app.js:211–291`（形象元素的创建，以及 sprite 画布的创建和 `drawSprite` 绘制循环）、`app.js:1276–1361`（`artSource`、`alphaMap`、`artPoint`）、`rig.js`（全动态的 WebGL 网格渲染）、`style.css` 的 `.char-wrap` 和 sprite 规则，以及设置窗口 `admin/src/console/pages/Characters.tsx:537/565` 的“不支持”提示。代码原文见附录 B。
2. **测素材**：用 ffmpeg 把每张图集解码成 RGBA，按 `frame` 切格。每帧取 alpha ≥ 128 的不透明像素（和 `scripts/art/check_model_chan.py` 的阈值相同），记录头顶 y0、脚底 y1、身高、左右边界和重心 x，结果写成 `frames.jsonl`，共 4680 行。然后统计“用同一条裁切线时每个动作帧露出多少”。脚本见附录 C。
3. **看图定腰线**：把每包 daily 的 idle#0 躯干放大，每隔 0.02 身高画一条刻度线，读出腰带 / 衣服收腰的位置和交叠双手下沿的位置。再按建议值渲染“同一裁切框下 10 个代表帧”的模拟半身预览，逐张核对。

## 2. 三类的可行性结论

| kind | 内置包 | 结论 | 一句话理由 |
| --- | --- | --- | --- |
| **sprites** | 15 个：`*-pixel` ×5（664×904，HD，`pixelated: false`），`*-adult` ×5（同规格，18+），`*-classic` ×5（83×113，`pixelated: true`） | **可行，本目标实现** | 绘制只是 `drawImage` 的源矩形到目标矩形，改源矩形就能裁切和放大。所有图集都是“脚底贴帧底、身高约 80% 帧高”的固定构图，同一条裁切线适用于 35/36 个动作帧，素材分辨率也够。 |
| **pictures** | **0 个**（内置包里没有这个类型，只有用户可能导入） | **技术上有条件可行，本目标不做** | 每套服饰一张任意构图的静态图，没有统一的腰线和构图约定，没有样本可以校准；动作靠 CSS 以脚底为原点做跳、挤、倾斜，裁掉脚以后这些动作的支点在画外。 |
| **rig** | 1 个：`dafeiyu-live`（只有 daily） | **技术上可行，本目标不做，列为后续** | WebGL 网格可以只改投影（`rig.js:57–61` 的 `uSize` 改成“偏移 + 缩放”），模型里也有 `pivots` 和 `legs` 可以推腰线；但只有一个包、一套服饰，触摸命中走的是 2D alpha 路径，需要单独实现和验证。不在“像素动态”这个目标的范围内。 |

（大肥鱼的原版视频片段 `look: null` 不是形象包 kind，不在讨论范围内。）

### 2.1 sprites：可行（证据）

- **渲染路径能裁切**：`app.js:231–245` 为桌宠（`className === 'char'`）建一张和帧同尺寸的 canvas（`k = 1`，HD 包是 664×904，classic 包是 83×113）。`app.js:274–291` 的 `drawSprite` 每帧执行一次 `ctx.drawImage(img, (col+i)·w/k, row·h/k, w/k, h/k, 0, 0, canvas.width, canvas.height)`。只要把“整格”源矩形换成“帧的上半部分”，就是半身，不需要新的运行时。
- **布局不用改**：`.char-wrap .char.sprite { width: auto; height: 100% }`（`style.css:276`）按 canvas 的宽高比排版。半身裁切框保持帧的宽高比 664:904 = 83:113 ≈ 332:452 = 0.7345（和 VRM / Live2D 的 332×452 画布比例相同），所以窗口、`#char-wrap` 和右下角锚点都不变，和 VRM / Live2D 的“同一个窗口里画得更大”一致。
- **素材构图统一**（附录 A 的 A 和 E 节）：HD 包所有帧的脚底 y1 都在 895–903（帧高 904）。站姿帧的头顶 y0 中位数是 183–188，身高约 715–720 px，约占帧高 80%，水平重心在 320–335（帧宽 664 的中线是 332）。classic 包脚底在 110–112（帧高 113），身高 90–96。也就是说，“身高比例的腰线”换算成帧内像素后，在同一张图集里是一条固定的横线。
- **动作帧逐个检查**（附录 A 的 B、C 节）：
  - 绝大多数动作（idle、pat、talk、look、sad、hungry、think、eat_*、happy、walk、evolve、sleep）在同一裁切线下露出的身高比例和建议 waist 相差不到 ±0.05。仓库里**没有躺下或坐下的帧**：`sleep` 是闭眼站立（头顶 154–192，脚底 902–903），`walk` 是站立侧身。
  - `lifted`（拎起）：脚仍在帧底，但人画得短一些，头顶比站姿低约 30–75 px，露出比例 0.37–0.50。半身下她在画面里低一点、小一点，头和躯干完整，可以接受（和 Live2D 半身“跳起时露出腰下”是同一类现象）。
  - `play#1`、`eat_fruit`、`think#1`、`sleep#1` 等帧的顶端有举起的手、举过头的西瓜、思考气泡或 zzz，会比头顶高。按建议的 8% 头顶留白，每包只有 1–5% 的帧顶端超出裁切框，最多超出 70 px（dafeiyu-pixel bikini/idle#1，这一帧本身就画大了约 13%，属于素材的已有不一致），被裁掉的是装饰或手尖，不是脸。
  - **唯一的结构性例外是 `hatch#0`（蹲下）**：头顶在 236–423，露出比例低至 0.22–0.37，半身下只在底边露出头顶或发顶，下一帧 `hatch#1` 才“冒出来”。`hatch` 只在唤醒或切换角色时播放约 1 s，读起来是“从画面底下探出头”，语义上说得通。所以**不为它单独换裁切线**（换了反而会让裁切框在两帧之间跳动）。详见 §3.9。
- **清晰度够**：HD 包半身的源裁切高度约 390–406 px。桌宠显示高度是 186 CSS px × `petScale`（默认 1.25，最大 2.5，见 `settings.js:18`）× DPR：默认 DPR 1 时约 232 设备 px，源像素仍在缩小；最大尺寸配合 Retina 屏约 930 设备 px，放大约 2.3 倍，平滑采样可以接受。classic 包只有 83×113，半身后约 64 个源像素要撑满整个画面（7 倍），必须用最近邻采样加整数倍放大，见 §3.6。

### 2.2 pictures：本目标不做

- 绘制方式：`lookEl` 落到 `app.js:246–253`，就是一个 `<img class="char">`，没有任何取景逻辑。动作靠 `style.css:244–252` 的 CSS 动画表现（`char-hop`、`char-squish`、`rotate(-3deg/-4deg)`，`transform-origin: 50% 100%`，以脚底为原点）。
- 不做的原因：
  1. **没有样本**：17 个内置包里一个 `pictures` 都没有（附录 A 开头的 `kind` 清单），无法校准，也无法做 e2e 验证。
  2. **构图没有约定**：`pictures` 只要求每套服饰一张任意尺寸、任意构图的图（`docs/pet-packs.md`“pictures 类型不需要 frame 和 actions”）。图里的人可能本来就是半身、坐姿或带背景，“头顶 / 脚底 / 腰线”都没有保证；只有 `halfBody.waist` 一个参数时，第三方图很容易被裁坏。
  3. **CSS 动作的支点在脚底**：裁掉腿后，跳、挤、倾斜的支点会落在画面外，半身下的动作会变形，需要另外设计一套动作。
  4. 真正只有上半身的图，作者直接提供半身图即可，不需要应用来裁。
- 如果以后要做：可以复用本方案的 `spriteHalfCrop`，把整张图当作一帧（`frame = naturalWidth × naturalHeight`），用 canvas 代替 `<img>`，并把 CSS 动作的 `transform-origin` 改到画布底边。

### 2.3 rig（全动态）：技术可行，本目标不做

- 绘制方式：`rig.js:325` `createFigure` 用 WebGL 画一组分层网格。顶点着色器 `rig.js:57–61` 把模型像素直接映射到裁剪空间：`gl_Position = (aPos / uSize)·2 − 1`。画布尺寸按显示尺寸自适应（`rig.js:567–577` 的 `fit()`）。它没有 `setFraming`，所以在 `resolveFraming` 里一直 `supported: false`。
- 可行的地方：给着色器加 `uOffset/uScale` 两个 uniform，就是“只画上半身并放大”。`model.json` 有 `size: [664, 902]`、`pivots`（肩 352.65、肘 437.01、腿根 714.91）、`legs`（裙摆 752.13、脚底 902），可以推出腰线（头顶约 190.87；按肘部和交叠的手，腰线约在身高 0.45–0.50），比 sprites 还多结构信息。
- 不做的原因：
  1. **不在本目标范围**：目标是“像素动态半身”，rig 是另一套渲染器（WebGL 网格），不是像素素材。
  2. **只有一个包，而且只有 daily**（`dafeiyu-live`），用户也不能用常规方式导入 rig，收益小。
  3. rig 的触摸走 2D alpha（`rig.js:744` 写 `dataset.frame`），半身后要同时改投影、`data-cut` 和 alpha 缓存，还要单独做视觉回归（网格弯折和弹簧在放大后会更明显）。工作量和风险都应该单独立项。
- 后续建议：单独开一个任务，按“`setFraming` + `uOffset/uScale` + 腰线来自 `pivots` / `halfBody.waist`”实现，接口照抄本方案的 §3.3 和 §3.4。

## 3. sprites 半身设计（交给实现任务）

### 3.1 取景解析：只改 `SUPPORTED_KINDS`

- `src/core/framing.js:27` 改为 `const SUPPORTED_KINDS = ['vrm', 'live2d', 'sprites'];`。`resolveFraming` 的优先级（角色自己的选择 > 形象包 `framing` > 全局 `prefs.framing`）和返回结构 `{ mode, wanted, source, supported }` **完全不变**，所以设置窗口、`set-framing` IPC、`settings.json` 迁移都不用动。
- `pack.json` 的 `framing` 和 `halfBody` 已经对任意 kind 解析（`packs.js:484`，`resolveLook` 的 `packs.js:599` 把它们放进 `base`，sprites 的 look 会带上）。只需要把注释和 `docs/pet-packs.md` 里“（vrm / live2d）”的说明改为“vrm / live2d / sprites”。
- 单测：`test/framing.test.js:64` 目前断言 sprites `supported: false`，要改为 `supported: true`、`mode: 'half'`；另外加一条断言 `pictures` / `rig` 仍是 `supported: false, mode: 'full'`。

### 3.2 腰线来源和优先级

和 Live2D 的 `live2dHalfBand` 一样，按可信度依次取：

| `data-band` | 来源 |
| --- | --- |
| `pack` | `look.halfBody.waist`（`pack.json`，0.2–0.9，`PF.isWaist` 校验） |
| `default` | `L2D.dflt = 0.55`（和 Live2D 的默认值同一个常量，`framing.js` 里的 `L2D.dflt`） |

“测量”部分不测腰：像素图里没有 HitArea、眼睛参数这类结构信息，没有可靠的腰部特征。测的是**她的头顶、脚底和水平中心**（参考框），腰线按 `waist × 身高` 换算成帧内的 y。没有 `halfBody` 的第三方 sprites 包用 0.55；头身比正常的角色裁在大腿根附近，Q 版会裁到胸口，这两种情况都可以在 `pack.json` 里补 `halfBody.waist` 修正（建议值见 §4）。

**参考框（一张图集测一次）**：取 `idle, pat, talk, look, sad, think, happy` 中存在的动作的第 0 帧（最多 7 格），读出每格的不透明包围盒（alpha ≥ 128），取 top、bottom、cx 的**中位数**，得到 `ref = { top, bottom, cx }`（帧内像素）。

- 为什么不用 idle#0 单帧：dafeiyu-pixel 的 `idle#0` 头顶在 194，`idle#1` 在 100（画大了）；用中位数做参考时，超出裁切框顶的帧更少（附录 A 的 C 节，dafeiyu-adult 从 77 帧降到 27 帧，gpt-adult 从 118 帧降到 17 帧）。
- 为什么不扫整张图集：一张 2656×8136 的 HD 图集解码后约 86 MB，全表 `getImageData` 太贵。7 格的中位数和全表 36 帧的中位数在 130 张图集里有 126 张相差 ≤ 2% 身高（附录 A 的 D 节）；超过的 4 张（dafeiyu-adult nurse / office、gpt-adult retro_swimsuit / knit_dress）是素材本身各帧大小不一致。
- 每张图集测一次（换服饰就是换图集），缓存在 `sheets` 的 entry 上（`app.js:149` 的 `sheets` Map，`e.ref`）。可以用 `OffscreenCanvas` 按 1/4 分辨率采样（HD 一格 166×226），7 格耗时可以忽略。读不到像素（tainted）时 `ref = { top: 0, bottom: frame.h, cx: frame.w / 2 }`，即把整帧当作她的身高。

### 3.3 裁切公式（新增纯函数 `spriteHalfCrop`，放进 `framing.js` 并写单测）

```js
// 输入：ref = { top, bottom, cx }（帧内 px，y 向下）；frame = { w, h }；waist（0.2–0.9）；
//      canvas = { W, H }（画布像素尺寸）；pixelated（bool）。SPRITE_MARGIN = 0.08（头顶留白，占画布高度）
// 输出：源裁切矩形 { sx, sy, sw, sh }（帧内 px，可能伸出帧外），以及 cut（给触摸用）
function spriteHalfCrop(ref, { frame, waist, canvas, pixelated, margin = SPRITE_MARGIN }) {
  const H = Math.max(1, ref.bottom - ref.top);            // 她的身高（头顶 → 脚底）
  const cutY = ref.top + waist * H;                       // 腰线在帧内的 y：落在画布底边
  let sh = Math.min(frame.h, (cutY - ref.top) / (1 - margin)); // 头顶 → 腰线占画布高度的 92%
  if (pixelated) {                                        // 整数倍：每个源像素 = s×s 个画布像素
    const s = Math.max(1, Math.floor(canvas.H / sh));
    sh = canvas.H / s;                                    // 略高于所需，多出来的放到头顶
  }
  const sw = sh * frame.w / frame.h;                      // 保持帧的宽高比（布局不变）
  let sy = cutY - sh;
  let sx = ref.cx - sw / 2;                               // 以她的重心水平居中
  if (pixelated) { sy = Math.round(sy); sx = Math.round(sx); } // 源像素对齐画布像素格
  return { sx, sy, sw, sh, cut: Math.min(1, waist) };
}
// 全身 = { sx: 0, sy: 0, sw: frame.w, sh: frame.h }（和现在完全一样）
```

**绘制**（替换 `drawSprite` 里的那一行 `drawImage`）：源矩形是格内坐标 `(sx, sy, sw, sh)`，**必须裁到本格 `[0, frame.w] × [0, frame.h]` 以内**，否则会读到图集里相邻的帧。目标矩形按比例跟着缩：

```js
const kx = canvas.width / c.sw, ky = canvas.height / c.sh;
const x0 = Math.max(0, c.sx), y0 = Math.max(0, c.sy);
const x1 = Math.min(frame.w, c.sx + c.sw), y1 = Math.min(frame.h, c.sy + c.sh);
ctx.drawImage(img, (cellX + x0) / k, (cellY + y0) / k, (x1 - x0) / k, (y1 - y0) / k,
              (x0 - c.sx) * kx, (y0 - c.sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
```

其中 `cellX = (a.col + i)·frame.w`，`cellY = a.row·frame.h`，`k` 就是现有的 1/2 缩放图集系数（桌宠是 1）。

效果：腰线 `cutY` 正好落在画布底边；头顶到腰线占画布高度 92%，上方留 8%；她按头身的重心水平居中；放大倍数 = `frame.h / sh`，HD 包约 2.2–2.3 倍，classic 包 1.5–1.75 倍（相对帧尺寸），并且至少是全身大小（`sh ≤ frame.h`）。

**为什么留白用 8%，而不是 VRM / Live2D 的 5%（`HALF.margin`）**：VRM 量的是头部顶点，Live2D 量的是图层，参考的都是“头”；像素帧顶端常有手、道具、气泡等特效。实测 5% 留白时每包有 2.6–7.9% 的帧被裁到顶端，8% 时降到 1.1–5.1%，被裁的最多 70 px，而且都是装饰（附录 A 的 C 节）。建议在 `framing.js` 里作为单独的常量 `SPRITE_MARGIN = 0.08`，并写明原因。

### 3.4 渲染接口：和 VRM / Live2D 一样的 `setFraming()`

在 `lookEl` 的 sprites 分支（`app.js:231–245`）里，给桌宠 canvas 挂一个和 live figure 相同形状的对象，这样 `syncFraming`（`app.js:64–71`）**不用改**，它已经在调用 `el.petFigure.setFraming(f.mode)`：

```js
if (className === 'char') {
  s.framing = opts.framing || 'full';                          // 初始取景：lookEl 调用方传 framingOf(look).mode（和 live figure 的 createFigure(c, look, { framing }) 一样）
  c.petFigure = {
    setFraming(mode, { instant = false } = {}) {
      const next = mode === 'half' ? 'half' : 'full';
      if (next === s.framing) return false;
      s.glide = instant || look.pixelated ? null : { from: currentCrop(s), t0: performance.now() };
      s.framing = next;
      if (look.pixelated) resizeForPixels(s);                  // 见 3.6
      drawSprite(s, performance.now());                        // 立即重画：不重新取图、不重建 canvas
      return true;
    },
  };
}
```

- **不重载**：图集（`useSheet`）、canvas 元素、动作计时 `s.start` 都保留，只换源矩形。
- **平滑切换（可选，建议做）**：HD 包把源矩形 `{sx, sy, sw, sh}` 在 0.35 s 内用 smoothstep 从当前值滑到目标值（写法和 `PF.blendPlacement` 一样，可以新增 `blendRect`，或者复用 `blendCamera` 的缓动）。注意现在帧循环只在有 rig 时才跑满 rAF（`app.js:1885–1886`，否则每 80 ms 一次），滑动期间要让循环跑满帧（比如 `if (rigs.size || spriteGliding) requestAnimationFrame(...)`）。pixelated 包直接切换，不滑动：滑动时的非整数倍最近邻会让像素闪烁。
- **调试字段**（每次 `drawSprite` 写到 canvas 上，只在值变化时写，和 `live2d.js:322–324` 的写法一致）：
  - `data-framing` = `full` / `half`；
  - `data-cut` = 半身时 `waist.toFixed(3)`，全身时 `'1'`；
  - `data-band` = `pack` / `default`；
  - 可选 `data-crop` = `sx,sy,sw,sh`，供 e2e 断言。
- **`window.petFx`**：加一个 `sprite()` 返回 `{ framing, band, waist, ref, crop, gliding }`，和 `petFx.live2d()`、`petFx.vrm()` 对应，供 e2e 用。

### 3.5 触摸映射：复用 `toFullBody`，只要改一处缓存键

- `artPoint`（`app.js:1338–1361`）已经通用：`artSource` 对 canvas 取 `canvas.width/height`（`app.js:1282`），`readAlpha` 读的就是**画布上已经裁好的画面**，`b.y0` 是她可见的头顶，`b.y1` 是画布底边（腰线）。看到 `data-framing="half"` 时用 `PF.toFullBody({ y }, { mode: 'half', cut })` 得到 `y·cut`，换回全身比例。`cut = waist` 的含义和 Live2D 相同（Live2D 的 `band.cut = clamp01(share)`），头、脸、胸、手、肚子照常命中，**腿和脚在半身下点不到**。
- **必须改的一处**：`alphaMap` 的缓存键是 `canvas.dataset.frame`（`app.js:1291`）。现在的值是 `${url}#${row}:${col}`（`app.js:289`），切换取景后同一帧的键不变，会继续用全身的 alpha。半身时把键加上取景和裁切，例如 `${url}#${row}:${col}@half:${sx|0},${sy|0},${sw|0}`。滑动期间每帧的裁切不同，自然会重新读取。
- 镜像（朝左，`.pet-body[data-facing="left"] .char { scale: -1 1 }`）：因为她按重心居中，镜像后仍在中间，`artPoint` 现有的 `mirrored` 换算不用改。

### 3.6 像素清晰度（imageSmoothing）

规则沿用现有的 `ctx.imageSmoothingEnabled = !look.pixelated`（`app.js:283`），并按素材分两种处理：

| 素材 | 内置包 | 半身处理 |
| --- | --- | --- |
| `pixelated: true`（硬像素画） | `*-classic`（83×113） | `imageSmoothingEnabled = false`（最近邻），并且整数倍放大：半身时把 canvas 的像素尺寸改为 `frame × n`，`n = round(452 / frame.h)`（classic 包是 ×4 = **332×452**，和 VRM / Live2D 画布相同）。`spriteHalfCrop` 取整数 `s = floor(452 / sh)`（实测 classic 是 6 或 7），`sx`、`sy` 取整，每个源像素正好是 s×s 个画布像素，不会出现粗细不一的像素块。CSS 已有 `canvas { image-rendering: pixelated }`（`style.css:23`）。切回全身时把 canvas 恢复为帧尺寸。 |
| `pixelated: false`（平滑高清，名字里有“像素”但其实是 HD 画） | `*-pixel`、`*-adult`（664×904） | 保持 `imageSmoothingEnabled = true`，`imageSmoothingQuality = 'high'`（这类素材是抗锯齿的平滑画，最近邻反而会出锯齿）。canvas 保持 664×904：源约 390–406 px 画进 904 px 高的画布，再由 CSS 缩到显示尺寸。默认大小下源像素多于屏幕像素，最大尺寸配合 Retina 约放大 2.3 倍，可以接受。`style.css:25` 的 `canvas.sprite:not(.pixelated) { image-rendering: auto }` 保持不变。 |

说明：任务描述里的“放大填满 332×452 canvas”，在本设计里指和 VRM / Live2D 相同的 332×452 显示比例。classic 包半身的画布正好是 332×452；HD 包为了不降低清晰度，保留 664×904（同比例，是 2 倍分辨率）。

### 3.7 设置窗口“不支持”提示怎么改

- `admin/src/console/pages/Characters.tsx:537`：`const camera = ch?.look?.kind === 'vrm' || ch?.look?.kind === 'live2d';` 改成按 kind 判断，最好和 `SUPPORTED_KINDS` 共用同一份清单（例如 `view` 里每个角色带上 `framingSupported`，由主进程用 `framing.js` 的 `resolveFraming(...).supported` 算出来，前端不再硬编码 kind）。
- `Characters.tsx:565` 不支持时的文案改为：`目前 VRM、Live2D 和像素形象包能半身取景；她现在穿的形象包（图片 / 全动态）保持全身。`
- `src/core/settings-schema.js:109` 中 `prefs.framing` 的说明改为：`…对 VRM、Live2D 和像素角色生效（图片 / 全动态角色保持全身）…`。
- `docs/half-body-mode.md` 的“设置”和“`SUPPORTED_KINDS`”两处、`docs/pet-packs.md` 中 `framing` / `halfBody` 的注释，也要同步写上 sprites。
- 改完 UI 后按 CLAUDE.md 跑 `node "$LOBE_DESIGN/scripts/lint-lobe.mjs" admin/src/console/pages/Characters.tsx`。

### 3.8 不受影响的部分

- 全身取景：`sx = 0, sy = 0, sw = frame.w, sh = frame.h`，和现在逐像素相同。
- 卡片、衣柜、孵化页的小图（`className !== 'char'`）不挂 `petFigure`，一直是全身。
- 窗口尺寸和位置、`petScale`、气泡（在画布上方的布局里）、走路（窗口平移和 `walk` 帧）、心情色调（`.char-wrap[data-status=sad|sleep] .char` 的 filter）都和取景无关。
- `.char-wrap.has-sprites .char { animation: none; transform: none }`（`style.css:278`）：sprites 本来就不用 CSS 跳动，所以不会出现 pictures 那种“支点在画外”的问题。

### 3.9 已知取舍（写进 half-body-mode.md 的“已知问题”）

- `hatch#0`（蹲下）在半身下只露出发顶，下一帧才出现（各包露出比例最低 0.22–0.37）。不为它单独换裁切线，避免裁切框跳动。
- `lifted` 帧里她画得短，半身时低约 4–9% 画高。
- 少数举手、举物、气泡帧（每包 1–5%）顶端超出 8% 留白，被裁掉几十像素的装饰。
- 素材本身的大小不一致（如 dafeiyu-pixel 的 `idle#1` 大约 13%）在半身放大后更明显。修素材属于 `art/model-chan` 的流程，`check_model_chan.py` 的 12.5% 身高容差可以考虑收紧。
- 和 VRM / Live2D 一样，左右会裁掉张开的手臂、长发和尾巴：HD 包裁切宽约 287–299 px，比部分帧的人物宽度窄。

### 3.10 实现任务的验证建议

- 单测：`spriteHalfCrop`，覆盖腰线落在底边、8% 留白、宽高比、pixelated 整数倍和取整、`sh ≤ frame.h`；`resolveFraming` 对 sprites 返回 `supported: true`、对 pictures 和 rig 返回 `false`；`blendRect` 单调。
- e2e：仿照 `e2e/live2d-frame.js` 新建一个 `spriteframe` 场景。穿 claude-pixel → 全身截图 → 设置窗口 → 取景选“半身” → 检查窗口不变、`data-framing=half`、`data-cut=0.520`、`data-band=pack`、canvas 是同一个元素、腰线在底边、头在上方 → 点头部和胸口命中、腿和脚点不到 → 拎起、走路、说话 → 切回全身，画面逐像素和切换前一致 → 换 classic 包，看整数倍像素 → 重启后半身保留。截图在 `out/e2e/sprite-frame/`。

## 4. 每个现有像素包的 `halfBody.waist` 建议值

**取值原则**：裁在**交叠双手的下沿以下约 0.02–0.03**，不裁在腰带上。原因有两个：一是 idle、sleep、sad、pat 等多数帧的双手交叠在腰前（身高 0.46–0.49），裁在腰带（0.37–0.43）会把手切成两半；二是和同一角色的 Live2D 包保持一致（`dafeiyu-live2d` 写的是 `waist: 0.52`，也是裁在手下方）。

测量依据：参考头顶 y、脚底 y 是 daily 图集中 7 个站姿首帧不透明包围盒的中位数，身高 H = 脚底 − 头顶；“腰带 / 手下沿”是在放大 4 倍、每 0.02 身高一条刻度的 idle#0 躯干图上读出来的（±0.01）。完整逐帧数据见附录 A。

| 包 | pixelated | 帧 | 头顶 y / 脚底 y / H | 腰带（目测） | 双手下沿（目测） | **建议 waist** | 裁切线 y（帧内） | 默认 0.55 时的裁切线 y | 和默认值相比 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-pixel | false | 664×904 | 184 / 903 / 719 | 0.42 | 0.49 | **0.52** | 557.9 | 579.5 | 默认值多露约 22 px 裙子 |
| dafeiyu-pixel | false | 664×904 | 184 / 903 / 719 | 0.39 | 0.49 | **0.52** | 557.9 | 579.5 | 和 dafeiyu-live2d 的 0.52 一致 |
| gemini-pixel | false | 664×904 | 183 / 903 / 720 | 0.40 | 0.46 | **0.50** | 543.0 | 579.0 | 默认值多露约 36 px |
| gpt-pixel | false | 664×904 | 185 / 903 / 718 | 0.40 | 0.47 | **0.50** | 544.0 | 579.9 | 同上 |
| grok-pixel | false | 664×904 | 186 / 903 / 717 | 0.40 | 0.49 | **0.52** | 558.8 | 580.4 | 默认值多露约 22 px |
| claude-adult | false | 664×904 | 184 / 903 / 719 | 0.40 | 0.47 | **0.50** | 543.5 | 579.5 | |
| dafeiyu-adult | false | 664×904 | 185 / 903 / 718 | 0.39 | 0.49 | **0.52** | 558.4 | 579.9 | |
| gemini-adult | false | 664×904 | 188 / 903 / 715 | 0.38 | 0.46 | **0.50** | 545.5 | 581.3 | |
| gpt-adult | false | 664×904 | 184 / 903 / 719 | 0.40 | 0.48 | **0.50** | 543.5 | 579.5 | |
| grok-adult | false | 664×904 | 183 / 902 / 719 | 0.40 | 0.48 | **0.50** | 542.5 | 578.5 | |
| claude-classic | true | 83×113 | 15 / 110 / 95 | 0.55 | 0.58 | **0.60** | 72.0 | 67.3 | 默认值会裁到手 |
| dafeiyu-classic（Q 版大头） | true | 83×113 | 17 / 112 / 95 | 0.66 | 0.70 | **0.72** | 85.4 | 69.3 | 默认值会裁到胸口 |
| gemini-classic | true | 83×113 | 20 / 110 / 90 | 0.60 | 0.62 | **0.66** | 79.4 | 69.5 | 默认值会裁到胸口 |
| gpt-classic | true | 83×113 | 17 / 111 / 94 | 0.55 | 0.58 | **0.60** | 73.4 | 68.7 | 默认值会裁到手 |
| grok-classic | true | 83×113 | 16 / 111 / 95 | 0.56 | 0.60 | **0.62** | 74.9 | 68.3 | 默认值会裁到手 |

按这些值换算的源裁切矩形 `(sx, sy, sw, sh)` 和放大倍数见附录 A 的 E 节。例如 claude-pixel 是 `(180.9, 151.5, 298.5, 406.4)`，帧到画布放大 2.22 倍；dafeiyu-classic 是 `(13.2, 10.1, 55.3, 75.3)`，画布 332×452，每个源像素 6×6。

**在全部服饰、全部动作上的检验**（附录 A 的 B、C 节，按上表的 waist、8% 留白、7 帧中位数参考）：

- 标准站姿动作在同一裁切线下露出的比例和 waist 相差不到 ±0.05（例：claude-pixel 的 idle 0.52、talk 0.48–0.52、walk 0.51–0.52、sleep 0.50–0.54）。
- `lifted` 0.35–0.53（画得短）；`play`、`evolve` 0.39–0.57（跳起或举手）；`hatch` 最低 0.22（蹲下，见 §3.9）。
- 顶端超出裁切框的帧：claude-pixel 10/468，dafeiyu-pixel 7/468，gemini-pixel 19/468，gpt-pixel 14/468，grok-pixel 5/468；adult 包 8–22/432；classic 包除 claude-classic 外为 0（claude-classic 16/36，最多 10 个源像素，都是头顶的花饰）。

> 落地时把上表的值写进 15 个包的 `pack.json`，即 `"halfBody": { "waist": … }`。classic 包的值是在 83×113 的小图上读的，误差约 ±0.02，实现时请用 `spriteframe` 的截图复核。

## 5. 后续动作

1. **实现任务（sprites 半身）**：按 §3.1–3.7 修改 `framing.js`（`SUPPORTED_KINDS`、`spriteHalfCrop`、`SPRITE_MARGIN`、`blendRect`）、`app.js`（sprites 的 `petFigure.setFraming`、`drawSprite` 的裁切绘制、参考框测量、调试字段、`alphaMap` 缓存键、滑动期间的帧率）、`Characters.tsx` 和 `settings-schema.js` 的文案，按 §4 给 15 个包加 `halfBody.waist`，再补单测和 `spriteframe` e2e。
2. **协调**：工作区里 `src/core/packs.js` 和 `pet-service.js` 正在被另一个任务修改（T-2752：`resolveLook` 只用所选包）。实现时以合并后的 `resolveLook` 为准，并确认 `look.halfBody` 和 `look.framing` 仍然会传给 sprites 的 look。
3. **另立任务（可选）**：rig 半身（§2.3）；pictures 半身等出现真实的 pictures 包后再评估（§2.2）。

---

## 附录 A：素材测量原始输出

完整输出共 684 行，作为本任务的证据另行上传（`measurement-output.txt`）。这里摘录 claude-pixel 的 daily 逐帧数据，以及汇总统计。

```
claude-pixel daily (frame 664x904, pixelated false) ref top 184 soles 903 → W 0.52 cut y 557.9
action#i   y0(top) y1(soles) height  minX maxX  cx     share-above-cut
idle#0         184      903     720   202  465  332.9  0.519
idle#1         184      903     720   196  462  328.4  0.519
lifted#0       248      903     656   198  463  331.2  0.472
sleep#0        177      903     727   206  459  333.2  0.524
sleep#1        154      903     750   202  457  329.7  0.539
think#1        162      903     742   203  456  330.7  0.534
play#1         160      903     744   203  465  333.3  0.535
hatch#0        353      901     549   190  483  334.2  0.373
hatch#1        180      903     724   180  483  328.8  0.522
evolve#0       214      903     690   201  475    347  0.498
walk#0         184      903     720   187  489  339.2  0.519
（其余帧见完整输出）

C. 稳健参考 + 留白 8%：
claude-pixel W=0.52: 468 frames; poke above crop top 10 (2.1%, worst 37 px cat_ears/play#1); head-only 1
dafeiyu-pixel W=0.52: 468 frames; poke above crop top 7 (1.5%, worst 70 px bikini/idle#1); head-only 11
gemini-pixel W=0.5: 468 frames; poke above crop top 19 (4.1%, worst 41 px daily/eat_fruit#0); head-only 0
gpt-pixel W=0.5: 468 frames; poke above crop top 14 (3.0%, worst 51 px beret/play#1); head-only 13
grok-pixel W=0.52: 468 frames; poke above crop top 5 (1.1%, worst 12 px daily/play#1); head-only 0
（head-only 全部是 hatch#0）

D. worst difference 7-frame median vs 36-frame median: 9.47% at gpt-adult/retro_swimsuit; sheets 130; >2%: 4
```

## 附录 B：代码现状摘录

完整摘录另行上传（`code-excerpts.txt`，用 `git show HEAD:<file>` 生成）。要点如下：

```
src/core/packs.js:29        const KINDS = ['sprites', 'pictures', 'rig', 'live2d', 'vrm'];
src/core/packs.js:484       const halfBody = m.halfBody === undefined ? null : … isWaist(m.halfBody.waist) ? { waist } : null;   // 不分 kind
src/core/packs.js:599       const base = { packId, kind, url, pixelated, ...(p.framing ? { framing } : {}), ...(p.halfBody ? { halfBody } : {}) };
src/core/framing.js:27      const SUPPORTED_KINDS = ['vrm', 'live2d'];
src/core/framing.js:54-55   const supported = !!look && SUPPORTED_KINDS.includes(look.kind); return { mode: supported ? wanted : 'full', … }
src/core/framing.js:199     function toFullBody(pt, framing) { … return { ...pt, y: pt.y * Math.min(1, framing.cut) }; }
src/renderer/app.js:68      if (el && el.petFigure && el.petFigure.setFraming && f) el.petFigure.setFraming(f.mode);
src/renderer/app.js:144     const LIVE_KINDS = { rig: …, live2d: …, vrm: … };      // sprites 不在其中，走 231 行的分支
src/renderer/app.js:235     const k = className !== 'char' && !look.pixelated && look.frame.width >= 400 ? 2 : 1;
src/renderer/app.js:283     ctx.imageSmoothingEnabled = !look.pixelated;
src/renderer/app.js:287     ctx.drawImage(img, ((a.col + i) * w) / k, (a.row * h) / k, w / k, h / k, 0, 0, canvas.width, canvas.height);
src/renderer/app.js:1291    const key = … a.el.tagName === 'CANVAS' ? a.el.dataset.frame : a.el.src;     // 需加上取景
src/renderer/app.js:1358    const half = a.el.dataset && a.el.dataset.framing === 'half' ? { mode: 'half', cut: Number(a.el.dataset.cut) } : null;
src/renderer/live2d.js:281  function setFraming(mode, { instant = false } = {}) { … glide = instant ? null : { from: { ...base }, t0 }; fit(true); }
src/renderer/live2d.js:322  if (d.framing !== framing) d.framing = framing; … d.cut = framing === 'half' && shape ? shape.band.cut.toFixed(3) : '1';
src/renderer/vrm.js:416     function setFraming(mode, { instant = false } = {}) { … }
src/renderer/rig.js:61      gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0);
admin/…/Characters.tsx:537  const camera = ch?.look?.kind === 'vrm' || ch?.look?.kind === 'live2d';
admin/…/Characters.tsx:565  '目前只有 VRM 和 Live2D 形象包能半身取景；她现在穿的形象包保持全身。'
src/core/settings-schema.js:109  '…对 VRM 和 Live2D 角色生效（像素 / 图片 / 全动态角色保持全身）…'
```

## 附录 C：测量脚本

脚本放在仓库外（`/tmp/sprite-measure/`），只读取素材，作为证据另行上传。核心是 `measure.js`：

```js
// 用 ffmpeg 把图集解码成 RGBA，按 pack.json 的 frame 切格，alpha >= 128 计为不透明，
// 每帧输出 { id, outfit, action, i, top, bottom, h, minX, maxX, cx }
for (const id of packs) { const p = pack.json; if (p.kind !== 'sprites') continue;
  for (const [outfit, rel] of Object.entries(p.outfits)) { const img = decode(rel);
    for (const [action, a] of Object.entries(p.actions)) for (let i = 0; i < a.frames; i++)
      console.log(JSON.stringify({ id, outfit, action, i, ...cell(img, (a.col + i) * fw, a.row * fh, fw, fh) })); } }
```

其余脚本：`frame-table.js` 输出逐帧表；`by-action.js` / `by-action2.js` 统计同一裁切线下每个动作的露出比例和超出裁切框顶的帧；`refcheck.js` 比较 7 帧和 36 帧中位数；`summary.js` 输出 §4 的裁切矩形；`zoom.js` / `classic-lines.js` 画躯干刻度图；`half-preview.js` 渲染模拟半身预览。
