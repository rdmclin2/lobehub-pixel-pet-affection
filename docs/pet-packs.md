# 角色包（Pet Pack）格式 · schema 2

角色包决定一个角色**长什么样**：每套服饰一张立绘，或者每套服饰一张像素动作精灵图。应用自带几套（`src/renderer/packs/`），用户自己的放在用户数据目录的 `packs/` 下（⋯ 菜单 → 角色列表 → 角色 → 外观 → “导入角色包…”或“打开角色包文件夹”）。这份格式也是以后角色包市场的上架格式。

角色包**只提供图片**。有哪些角色（`src/characters/<id>.json`）、有哪些服饰、什么好感阶段解锁、哪些属于成人向，全部由应用决定（`src/core/outfits.js`），角色包改不了。所以导入的角色包没法绕过 18+ 确认和“成人向内容”开关。动作怎么播放、何时触发也由应用的共享效果层决定（`src/core/fx.js`），所有角色一样。

## 目录结构

```
my-grok/
├── pack.json
└── sheets/
    └── daily.png
```

可以直接导入文件夹，也可以导入 `.zip`：`pack.json` 放在压缩包根目录，或者放在根目录下的唯一一个文件夹里。

## pack.json

```jsonc
{
  "schema": 2,                       // 2（推荐）或 1（旧格式，见下文）
  "id": "my-grok",                   // 3–40 位，a-z、0-9、"-"；不能和内置角色包重名，重名的导入包会覆盖旧版本
  "name": "我的格萝可",              // 显示名，最多 40 字
  "version": "1.0.0",
  "author": "你的名字",
  "license": "CC BY-NC-SA 4.0",      // 显示在外观列表里；第三方素材请写清授权
  "description": "可选，最多 200 字",
  "species": "grok",                 // 给哪个角色用：dafeiyu | claude | grok | gemini | gpt（src/characters/ 里的 id）
  "kind": "sprites",                 // sprites：像素动作精灵图；pictures：每套服饰一张静态图；rig：全动态（见下文）
  "pixelated": true,                 // 放大时保持硬像素（像素画请设为 true）
  "adult": false,                    // 可选：true = 18+ 角色包，只在确认年满 18 岁并打开成人向内容后列出和使用，可以带成人向服饰
  "frame": { "width": 83, "height": 113 },   // sprites 必填：单帧尺寸（像素）
  "actions": {                       // sprites 必填：每个状态在精灵图里的位置（行、起始列都从 0 开始）
    "idle":   { "row": 0, "col": 0, "frames": 2, "fps": 2 },
    "pat":    { "row": 0, "col": 2, "frames": 2, "fps": 4 },
    "lifted": { "row": 1, "col": 0, "frames": 2, "fps": 6 }
    // ……其余状态见下表，只有 idle 必填
  },
  "outfits": {                       // 服饰 id → 图片（png / webp / gif / jpg，包内相对路径，单个不超过 8 MB）
    "daily": "sheets/daily.png"
  }
}
```

- **服饰 id**：`daily`、`scarf`、`casual`、`beret`、`idol`、`pajamas`、`cat_ears`、`swimsuit`、`yukata`、`bikini`、`qipao`、`maid`、`offshoulder_gown`、`couple_hoodie`、`flower_crown`、`retro_swimsuit`、`silk_robe`、`office`、`nurse`、`stewardess`、`bunny`、`knit_dress`、`devil_cos`（最后这些和 `maid`、`offshoulder_gown` 一样是成人向）。角色平时只会穿她的 character.json 里 `outfits` 列出的服饰；穿 18+ 角色包（`"adult": true`）时，衣柜改为这个包里有图的服饰，成人向的也算；包里缺的服饰先用这个角色的默认角色包，再用她的回落包（`art.fallbackPack`）。
- **`swimsuit` 与 `retro_swimsuit` 的区别**：`swimsuit`（运动泳装，亲近 ♥35，**全年龄**）是高领短袖的运动款连体泳衣，外面穿及膝沙滩裤和长袖防晒开衫，胸口、腰腹和臀部都遮住；五位内置角色的默认包都带这张图（`sheets/swimsuit.webp`）。`retro_swimsuit`（高开衩连体泳衣，恋人 ♥85，**成人向**）只在确认 18+ 并打开成人向内容后显示，而且只在 `adult: true` 的角色或 18+ 角色包上出现；内置角色只有成年版角色包（`<id>-adult`）带它的图。导入包给 `swimsuit` 提供的图也要符合同样的全年龄标准（不是比基尼、不露腰、不高开衩）。
- **18+ 角色包与成人向衣柜**（T-1261，2026-10-31）：五位内置角色各有一个成年版角色包 `<id>-adult`（`"adult": true`）：20 岁的成年形象，目前有日常服和性感女仆装（暧昧 ♥60）两套（另外 9 套成人向服饰已经定义，提示词也写好了，但 2026-10-31 生图时被服务的安全暂停拦下，还没有图，所以不显示）。只有确认年满 18 岁并打开“成人向内容”后，它才出现在“外观”里；选了它，衣柜换成这个包里有图的服饰。关掉成人向内容时她换回默认外观，身上的成人向服饰换回最近穿过的全年龄服饰。角色包只影响外观和衣柜，人设、语气和话题仍按角色文件（五位都是 `adult: false`）。
- **`bikini`**（沙滩比基尼，暧昧 ♥60，**全年龄**）：比运动泳装清凉，但仍是全年龄标准：上衣从锁骨下方盖住整个胸口、不显胸型和乳沟，泳裙到膝盖上方、盖住臀部，外搭盖住肩膀的短开衫；只露出一窄条腰、手臂和小腿，布料不透明，没有内衣感和性暗示的姿势。五位内置角色的默认包都带这张图（`sheets/bikini.webp`）。导入包给 `bikini` 提供的图也要符合这个标准。
- **动作（schema 2）**：动作名就是应用的状态名（大肥鱼原版动画的 15 个状态 + `lifted`）。只有 `idle` 必填；缺的状态按回落链降级并叠加一个表情符号（例如 `eat_fruit` → `eat_rice` → `happy` → `idle`）。

| 动作 | 什么时候播放 | 缺了用 |
| --- | --- | --- |
| `idle` | 平时 | — |
| `look` | 自播链：东张西望 | `idle` |
| `happy` | 心情好；点击回应之一；自播链 | `idle` |
| `pat` | 点击回应之一（摸摸）；被甩出落地 | `happy` |
| `sad` | 心情低落；agent 出错 | `idle` |
| `hungry` | 饿了 | `sad` |
| `sleep` | 睡觉 | `idle` |
| `eat_rice` / `eat_cookie` / `eat_fruit` | 喂白饭 / 零食 / 水果 | `eat_rice` → `happy` |
| `think` | 等 agent 回复 | `idle` |
| `talk` | 说话 | `idle` |
| `play` | 玩耍；自播链 | `happy` |
| `hatch` | 唤醒、切换到这个角色 | `happy` |
| `evolve` | 关系升级 | `happy` |
| `lifted` | 被拖着走、被甩出去的空中 | `pat` |
| `walk` | 自己走动（窗口沿屏幕左右平移的同时播放；画成朝右的侧面，朝左走时应用会镜像） | `idle`，再加轻微的跳动 |

- **转身**（自播链里的左右镜像）由应用用 CSS 做，不需要单独的图；画了文字或标志、镜像会反字的状态，在角色的 character.json 里列进 `fx.noMirror`。
- **精灵图排布**：每一帧大小相同（`frame`），第 `row` 行、从第 `col` 列起连续 `frames` 帧。所有服饰的精灵图必须使用同一种排布。内置像素包是 4 列 × 9 行（1328×4068，每帧 332×452，WebP，平滑绘制），每个状态 2 帧，第 9 行是 4 帧的 `walk` 侧身步行循环（朝右，5fps）。
- `pictures` 类型不需要 `frame` 和 `actions`，动作用轻微的摆动表现。
- `rig` 类型（全动态）见下一节。

## 全动态角色包（`"kind": "rig"`）

角色被拆成几张图层，每层是一张贴在网格上的图，挂在一副所有角色共用的骨架上，由 `src/renderer/rig.js` 用 WebGL 逐帧弯折，效果类似 Live2D：头发、裙摆、尾巴、鳍和呆毛靠弹簧跟着动作和拖拽摆动，眼睛会眨，说话有口型，各个状态有自己的表情。所有状态都由程序演出来，所以不需要 `frame` 和 `actions`。

```
my-rig/
├── pack.json          // "kind": "rig", "model": "model.json", "outfits": { "daily": "daily/preview.png" }
├── model.json
└── daily/
    ├── preview.png    // 整张图：列表、衣柜和没有 WebGL 时显示它
    ├── body.png       // model.json 里每个 part 一张，和 preview 放在同一个文件夹
    └── head.png …
```

`model.json`（坐标都是原图的像素）：

```jsonc
{
  "size": [332, 452],
  "parts": [                                   // 1–64 层；z 小的先画
    { "id": "hair", "deformer": "hair", "z": 2, "box": [96, 120, 129, 150], "grid": [8, 12] },
    { "id": "body", "deformer": "skirt", "z": 4, "box": [96, 162, 127, 290], "grid": [8, 16] },
    { "id": "head", "deformer": "head", "z": 6, "box": [120, 102, 86, 79], "grid": [8, 8] }
  ],
  "pivots": { "body": [163, 451], "head": [160, 178], "tail": [207, 292], "finL": [132, 146], "finR": [198, 146], "ahoge": [163, 111] },
  "legs": { "hem": 392, "feet": 451, "split": 163 },   // 裙摆下沿、鞋底、两腿之间：走路时腿在裙摆下迈步
  "face": { "box": [138, 142, 46, 34], "eyes": [[144, 149, 153, 159], [165, 149, 174, 159]], "mouth": [158, 166],
            "skin": [252, 232, 224], "ink": [70, 40, 70], "blush": [[146, 163], [176, 163]] }
}
```

- **deformer**（图层挂在哪根骨头上）：`body`（绕鞋底转动、呼吸、跳）、`skirt`（身体下半截：裙摆跟着摆，腿在下面迈步）、`hair`（长发：发根跟头转，发梢靠弹簧甩）、`tail`、`head`（绕脖子歪头，五官会稍微往看的方向滑）、`finL` / `finR` / `ahoge`（挂在头上单独扑动）。没有的部位不画就行，比如没有尾巴的角色就不放 `tail` 层。
- **face**：眼睛和嘴的位置。眨眼、闭眼（^ ^ / 睡着）、半睁、wink、生气、各种嘴型、腮红和眼泪，都是按这些位置实时画上去的，所以原图画一张睁眼闭嘴的脸就够了。
- **图层要多画一点被挡住的部分**：头发在头后面的部分、身体在头下面的部分，各自补上颜色，这样一层动起来时不会露出空洞。
- 只有部分服饰做了图层也可以：其他服饰穿这个角色的默认角色包。
- 本仓库的 `scripts/art/rig_cut.py` 按 `art/rig/<id>.json` 里的多边形，把一张图拆成这些图层，并写出 `model.json`（大肥鱼的拆法就在 `art/rig/dafeiyu.json`）。
- **schema 1**：旧格式的 8 个动作名 `idle / wave / lifted / eat / sleep / think / talk / cheer` 仍然可用，应用把 `pat` 映射到 `wave`，`happy`、`play`、`hatch`、`evolve` 映射到 `cheer`，三种吃饭映射到 `eat`。schema 1 包里不能写 schema 2 的新动作名。

## 内容要求

所有角色都必须是成年人（设定年龄至少 18 岁）。是否允许裸露和露骨内容按画风区分：

- **Q 版角色**（大头身、幼态画风，例如大肥鱼可选的原版 dsh-pet 动画）：任何服饰都不得出现裸露、内衣或露骨内容，成人向服饰的图也只能是风格上的变化。
- **其他角色**（成人比例，不是 Q 版或幼态）：可以出现裸露和露骨内容，但只能画在应用标为成人向的服饰里；这些服饰受 18+ 确认和“成人向内容”开关约束，全年龄服饰仍然不得出现。

无论哪种角色，都不得出现未成年或幼态特征的性化、强迫或不同意、真实人物。导入的角色包会标注“内容由作者负责”；上架市场前会按同样的标准审核，参见 `docs/compliance-review.md`。

## 自己做一个像素角色包

本仓库用 `scripts/art/` 生成内置的模型娘像素包（schema 2），可以照着做：

1. `python3 scripts/art/model_chan_prompts.py` 输出每个角色两条提示词（`<id>_base`、`<id>_extra`，各是 4×4 宫格：8 个状态各 2 帧，纯品红背景）。为了分辨率，每条再按行拆成两半（`_a` 是第 1–2 行，`_b` 是第 3–4 行），每半是 4×2 宫格，详见 [art/model-chan/README.md](../art/model-chan/README.md)。
2. 用 `lh generate image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"` 生成，每条一张（模型默认画布约 1024×1536，指定尺寸会报错）。
3. `scripts/art/slice_sheet.py <生成图> <输出.png> 4 2 360 --max 324x444 --smooth`：抠掉背景（品红底或透明底都行）、去掉相邻格子带过来的碎像素，缩成真正的像素画；`scripts/art/fit_cells.py <输入> <输出> --rows 2` 把每格放进 332×452（参数 `332 452`）。
4. `scripts/art/build_model_chan_pack.py <base_a> <base_b> <extra_a> <extra_b> <角色 id> src/renderer/packs/<角色 id>-pixel --hd`：四张拼成一张 1328×3616 的 WebP（`--hd`：全彩、`pixelated: false`），写出 schema 2 的 `pack.json`；`scripts/art/add_walk_frames.py --from art/model-chan/walk/<角色 id>_walk.png src/renderer/packs/<角色 id>-pixel` 把侧面步行循环（`model_chan_prompts.py --walk` 生成）加在第 9 行；`scripts/art/check_model_chan.py` 检查尺寸和每一帧都有内容。

新角色还需要一份 `src/characters/<id>.json`（字段见现有三个文件；`npm test` 会校验）。然后在应用里导入这个目录，或者打成 `.zip` 发给别人。
