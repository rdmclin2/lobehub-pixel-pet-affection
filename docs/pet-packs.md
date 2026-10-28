# 角色包（Pet Pack）格式 · schema 1

角色包决定一个伙伴**长什么样**：每套服饰一张立绘，或者每套服饰一张像素动作精灵图。应用自带几套（`src/renderer/packs/`），用户自己的放在用户数据目录的 `packs/` 下（⋯ 菜单 → 高级设置 → 外观 → “导入角色包…”或“打开角色包文件夹”）。这份格式也是以后角色包市场的上架格式。

角色包**只提供图片**。有哪些服饰、什么好感阶段解锁、哪些属于成人向，全部由应用决定（`src/core/outfits.js`），角色包改不了。所以导入的角色包没法绕过 18+ 确认和“成人向内容”开关：成人向服饰的图只有在开关打开时才会显示。

## 目录结构

```
my-bubbo/
├── pack.json
└── sheets/
    ├── daily.png
    └── maid.png
```

可以直接导入文件夹，也可以导入 `.zip`：`pack.json` 放在压缩包根目录，或者放在根目录下的唯一一个文件夹里。

## pack.json

```jsonc
{
  "schema": 1,                       // 固定为 1
  "id": "my-bubbo",                  // 3–40 位，a-z、0-9、"-"；不能和内置角色包重名，重名的导入包会覆盖旧版本
  "name": "我的泡鲸",                // 显示名，最多 40 字
  "version": "1.0.0",
  "author": "你的名字",
  "license": "MIT",                  // 显示在外观列表里；第三方素材请写清授权
  "description": "可选，最多 200 字",
  "species": "bubbo",                // 给哪个伙伴用：embit | bubbo | sprig | dafeiyu
  "kind": "sprites",                 // sprites：像素动作精灵图；pictures：每套服饰一张静态图
  "pixelated": true,                 // 放大时保持硬像素（像素画请设为 true）
  "frame": { "width": 83, "height": 113 },   // sprites 必填：单帧尺寸（像素）
  "actions": {                       // sprites 必填：每个动作在精灵图里的位置（行、起始列都从 0 开始）
    "idle":   { "row": 0, "col": 0, "frames": 2, "fps": 2 },
    "wave":   { "row": 0, "col": 2, "frames": 2, "fps": 4 },
    "lifted": { "row": 1, "col": 0, "frames": 2, "fps": 6 },
    "eat":    { "row": 1, "col": 2, "frames": 2, "fps": 3 },
    "sleep":  { "row": 2, "col": 0, "frames": 2, "fps": 1.5 },
    "think":  { "row": 2, "col": 2, "frames": 2, "fps": 2 },
    "talk":   { "row": 3, "col": 0, "frames": 2, "fps": 5 },
    "cheer":  { "row": 3, "col": 2, "frames": 2, "fps": 5 }
  },
  "outfits": {                       // 服饰 id → 图片（png / webp / gif / jpg，包内相对路径，单个不超过 8 MB）
    "daily": "sheets/daily.png",
    "maid": "sheets/maid.png"
  }
}
```

- **服饰 id**：`daily`、`scarf`、`casual`、`beret`、`pajamas`、`cat_ears`、`yukata`、`maid`、`offshoulder_gown`、`couple_hoodie`、`flower_crown`、`retro_swimsuit`、`silk_robe`。不用全部提供：缺的服饰会先用这个伙伴的默认角色包，再用它的立绘包。
- **动作**：只有 `idle` 必填，缺的动作播放 `idle`。应用的状态对应关系如下。

| 动作 | 什么时候播放 |
| --- | --- |
| `idle` | 平时、开心、饿了、难过（后三种会叠加色调） |
| `wave` | 被摸（点一下宠物） |
| `lifted` | 被鼠标拖着走 |
| `eat` | 喂食 |
| `sleep` | 睡觉 |
| `think` | 等 agent 回复 |
| `talk` | 说话 |
| `cheer` | 玩耍、关系升级 |

- **精灵图排布**：每一帧大小相同（`frame`），第 `row` 行、从第 `col` 列起连续 `frames` 帧。所有服饰的精灵图必须使用同一种排布。
- `pictures` 类型不需要 `frame` 和 `actions`，动作用轻微的摆动表现。

## 内容要求

所有角色都必须是成年人（成人比例，不是 Q 版或幼态）；不得出现裸露、内衣或露骨内容。成人向服饰的图也只能是风格上的变化，参见 `docs/compliance-review.md`。导入的角色包会标注“内容由作者负责”；上架市场前会按同样的标准审核。

## 自己做一个像素角色包

本仓库用 `scripts/art/` 生成内置的像素包，可以照着做：

1. `scripts/art/pixel_prompts.py <species>` 输出每套服饰的提示词（4×4 宫格：8 个动作各 2 帧，纯品红背景）。
2. 用 `lh generate image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"` 生成，每套服饰一张。
3. `scripts/art/slice_sheet.py <生成图> <输出.png> 4 4 96`：抠掉背景，去掉相邻格子带过来的碎像素，缩成真正的像素画（限制调色板、硬边透明）。
4. `scripts/art/build_pixel_pack.py <切好的目录> <species> <角色包目录>`：统一帧尺寸，写出 `pack.json`。

然后在应用里导入这个目录，或者打成 `.zip` 发给别人。
