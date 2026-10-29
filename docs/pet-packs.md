# 角色包（Pet Pack）格式 · schema 2

角色包决定一个角色**长什么样**：每套服饰一张立绘，或者每套服饰一张像素动作精灵图。应用自带几套（`src/renderer/packs/`），用户自己的放在用户数据目录的 `packs/` 下（⋯ 菜单 → 高级设置 → 外观 → “导入角色包…”或“打开角色包文件夹”）。这份格式也是以后角色包市场的上架格式。

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
  "kind": "sprites",                 // sprites：像素动作精灵图；pictures：每套服饰一张静态图
  "pixelated": true,                 // 放大时保持硬像素（像素画请设为 true）
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

- **服饰 id**：`daily`、`scarf`、`casual`、`beret`、`pajamas`、`cat_ears`、`yukata`、`maid`、`offshoulder_gown`、`couple_hoodie`、`flower_crown`、`retro_swimsuit`、`silk_robe`。角色只会穿她的 character.json 里 `outfits` 列出的服饰；包里缺的服饰先用这个角色的默认角色包，再用她的回落包（`art.fallbackPack`）。
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

- **转身**（自播链里的左右镜像）由应用用 CSS 做，不需要单独的图；画了文字或标志、镜像会反字的状态，在角色的 character.json 里列进 `fx.noMirror`。
- **精灵图排布**：每一帧大小相同（`frame`），第 `row` 行、从第 `col` 列起连续 `frames` 帧。所有服饰的精灵图必须使用同一种排布。内置像素包是 4 列 × 8 行（664×1808，每帧 166×226），每个状态 2 帧。
- `pictures` 类型不需要 `frame` 和 `actions`，动作用轻微的摆动表现。
- **schema 1**：旧格式的 8 个动作名 `idle / wave / lifted / eat / sleep / think / talk / cheer` 仍然可用，应用把 `pat` 映射到 `wave`，`happy`、`play`、`hatch`、`evolve` 映射到 `cheer`，三种吃饭映射到 `eat`。schema 1 包里不能写 schema 2 的新动作名。

## 内容要求

所有角色都必须是成年人（设定年龄 25 岁以上；角色包都用成人比例，不是 Q 版或幼态；只有大肥鱼可选的原版 dsh-pet 动画保留社区原版的 Q 版画风）；不得出现裸露、内衣或露骨内容。成人向服饰的图也只能是风格上的变化，参见 `docs/compliance-review.md`。导入的角色包会标注“内容由作者负责”；上架市场前会按同样的标准审核。

## 自己做一个像素角色包

本仓库用 `scripts/art/` 生成内置的模型娘像素包（schema 2），可以照着做：

1. `python3 scripts/art/model_chan_prompts.py` 输出每个角色两条提示词（`<id>_base`、`<id>_extra`，各是 4×4 宫格：8 个状态各 2 帧，纯品红背景）。为了分辨率，每条再按行拆成两半（`_a` 是第 1–2 行，`_b` 是第 3–4 行），每半是 4×2 宫格，详见 [art/model-chan/README.md](../art/model-chan/README.md)。
2. 用 `lh generate image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"` 生成，每条一张（模型默认画布约 1024×1536，指定尺寸会报错）。
3. `scripts/art/slice_sheet.py <生成图> <输出.png> 4 2 180 --max 162x222`：抠掉背景（品红底或透明底都行）、去掉相邻格子带过来的碎像素，缩成真正的像素画；`scripts/art/fit_cells.py <输入> <输出> --rows 2` 把每格放进 166×226。
4. `scripts/art/build_model_chan_pack.py <base_a> <base_b> <extra_a> <extra_b> <角色 id> src/renderer/packs/<角色 id>-pixel`：四张拼成一张 664×1808，写出 schema 2 的 `pack.json`；`scripts/art/check_model_chan.py` 检查尺寸和每一帧都有内容。

新角色还需要一份 `src/characters/<id>.json`（字段见现有三个文件；`npm test` 会校验）。然后在应用里导入这个目录，或者打成 `.zip` 发给别人。
