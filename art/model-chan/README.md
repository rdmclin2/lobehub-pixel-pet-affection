# 模型娘 · 首批角色素材

以 AI 模型厂商为主题的同人“模型娘”形象，**不是厂商官方形象**。设定文档见 [`CHARACTERS.md`](CHARACTERS.md)，设计记录在 [`characters.json`](characters.json)。应用实际读取的角色数据在 `src/characters/<id>.json`，像素包在 `src/renderer/packs/<id>-pixel/`。

| 角色 | 厂商 | 主题色 | 美术 | 素材位置 |
| --- | --- | --- | --- | --- |
| 大肥鱼（DeepSeek 娘，鲸鱼女仆） | DeepSeek | `#2C4A8A` | 默认是和其他四位同样成人比例的像素版（依 ai-chan-sheets `03_DeepSeek娘_鲸鱼娘` 重画）；Q 版只保留在原有透明视频（21 段：15 个基础状态 + 拎起、走路和 4 段点击回应变体）保留为可选外观 | `src/renderer/assets/dafeiyu/`、`src/renderer/packs/dafeiyu-pixel/` |
| 克洛蒂（Claude 娘，橘发菊纹） | Anthropic | `#C4622D` | 像素精灵图 | `src/renderer/packs/claude-pixel/` |
| 格萝可（Grok 娘，黑金吸血鬼） | xAI | `#8E1F33` | 像素精灵图 | `src/renderer/packs/grok-pixel/` |
| 杰米（Gemini 娘，四角星猫耳；第二批，2026-10-29） | Google | `#7B5CD6` | 像素精灵图 | `src/renderer/packs/gemini-pixel/` |
| 吉皮缇（GPT 娘，白龙；第三批，2026-10-29） | OpenAI | `#8E7FC8` | 像素精灵图 | `src/renderer/packs/gpt-pixel/` |

预览拼图：[`preview/model-chan-preview.png`](preview/model-chan-preview.png)。第一行是大肥鱼原视频的参考帧，下面五行是五个像素包，每列一个状态、每格该状态的 2 帧。

## 像素包格式

schema 2（见 `docs/pet-packs.md`）：RGBA WebP，单帧 332×452（全彩、软边，`pixelated: false`，应用里平滑绘制），一张 4 列 × 9 行（1328×4068），前 8 行是 16 个动作各 2 帧，动作名就是共享效果层的状态名（大肥鱼视频的 15 个状态 + `lifted`）；第 9 行是 `walk` 的 4 帧**侧身**步行循环（朝右走：左脚迈出、交叉、右脚迈出、交叉，5fps）。她在屏幕上是左右走的，所以走路画成侧面，朝左走时应用把它镜像；源图在 [`walk/`](walk/)（`model_chan_prompts.py --walk` 生成、抠好放进 332×452 格子的 4×2 宫格，两行是同一个循环画了两遍），`add_walk_frames.py --from` 取其中一行放进图集：每帧脚踩格子底边，头和上身居中，走起来身子平稳、只有腿、头发和裙子在动。5fps 时一步约 0.4 秒，在 100% 大小下约 44 px，和窗口的移动速度（`fx.js` `WALK.speed` 110 px/s）对上，脚不打滑。旧版像素包（`*-classic`，83×113）是另一套画（大肥鱼还是 Q 版），没有侧面图，仍用 `add_walk_frames.py` 从待机帧做的原地踏步。

## 重新生成

需要已登录的 `lh`、带 Pillow 和 numpy 的 python3、带 libvpx-vp9 的 ffmpeg。

```bash
python3 scripts/art/model_chan_prompts.py --halves > jobs.json # 每个角色 4 条提示词：<id>_base_a/_b、<id>_extra_a/_b（4×2 宫格）
lh generate image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"  # 每条一张，默认画布约 1024×1536（--width/--height 会报 ServerError）
python3 scripts/art/slice_sheet.py raw/<name>.png sliced/<name>.png 4 2 360 --max 324x444 --smooth   # 抠图（品红底或透明底；绿底加 --key green）、像素化、限制调色板（吉皮缇这类白色角色加 --octree）
python3 scripts/art/fit_cells.py sliced/<name>.png fit/<name>.png 332 452 --rows 2  # 放进 332×452 的格子，去品红边（绿底生成的加 --key green）
python3 scripts/art/build_model_chan_pack.py --hd fit/<id>_base_a.png fit/<id>_base_b.png fit/<id>_extra_a.png fit/<id>_extra_b.png <id> src/renderer/packs/<id>-pixel
python3 scripts/art/model_chan_prompts.py --walk > walk_jobs.json  # 每个角色 1 条：<id>_walk，侧身朝右的 4 帧步行循环 × 2 行（杰米绿底）
python3 scripts/art/slice_sheet.py raw/<id>_walk.png sliced/<id>_walk.png 4 2 360 --max 324x444 --smooth --shared-box   # 一个裁剪框，8 帧大小一致
python3 scripts/art/fit_cells.py sliced/<id>_walk.png art/model-chan/walk/<id>_walk.png 332 452 --rows 2
python3 scripts/art/add_walk_frames.py --from art/model-chan/walk/<id>_walk.png [--take 1] src/renderer/packs/<id>-pixel   # 侧面走路放进第 9 行（重建图集后要再跑一次）
python3 scripts/art/add_walk_frames.py src/renderer/packs/<id>-classic   # 旧版像素包：用待机帧做原地踏步
python3 scripts/art/check_model_chan.py                       # 校验尺寸、格式、每个动作的每一帧都有内容
python3 scripts/art/model_chan_preview.py art/model-chan/preview/model-chan-preview.png
```

2026-10-30 起的高清版（332×452，`--smooth` / `--hd`，同一批生成图）按上面的步骤生成；之前的 166×226 版本用的是 `4 2 180 --max 162x222`、64 色调色板：模型有时按要求给品红底，有时直接给透明底，`slice_sheet.py` 两种都能处理。杰米的紫粉发梢和品红太接近，抠图会吃掉发丝，所以她的 4 张提示词把背景改成纯绿 “perfectly flat solid pure green (#00FF00)”，`slice_sheet.py` 和 `fit_cells.py` 都加 `--key green`（要求透明底时模型会画出假的灰白棋盘格，不能用）。

## 其他服饰（以运动泳装 `swimsuit` 为例）

一套服饰对应角色包里的一张图集（`sheets/<outfit>.webp`），排布和 daily 完全一样（4×9，每帧 332×452，第 9 行是 4 帧朝右的侧身 walk）。服饰本身（解锁阶段、分级、中文名）定义在 `src/core/outfits.js`；角色要在 `src/characters/<id>.json` 的 `outfits` 里列出它，衣柜才会显示。提示词由 `model_chan_prompts.py` 的 `OUTFIT_LOOKS[<outfit>][<id>]` 给出：角色身份取 `CHARS[<id>]` 中 “ She wears ” 之前的部分，后面接这套衣服的描述；`OUTFIT_SAFE` 是附加的内容约束，`OUTFIT_WALK` 把走路提示词里的 “skirt” 换成这套衣服里会摆动的东西。不要画帽子：图会按身高缩放，加了帽子她会比 daily 小一圈。不加 `--outfit` 时，daily 的提示词和流程保持不变。

五位角色（`dafeiyu`、`claude`、`grok`、`gemini`、`gpt`）的泳装都已在 `OUTFIT_LOOKS["swimsuit"]` 里有描述，默认包里都有 `sheets/swimsuit.webp`。下面以克洛蒂为例；重画别的角色时把 `claude` 换成她的 id（杰米照旧用绿底，加 `--key green`；吉皮缇加 `--octree`），新服饰则先在 `OUTFIT_LOOKS` 里加一个键：

```bash
W=/tmp/swim; mkdir -p $W/raw $W/sliced $W/fit
python3 scripts/art/model_chan_prompts.py --halves --outfit swimsuit --char claude > $W/jobs.json   # claude_swimsuit_base_a/_b、_extra_a/_b
python3 scripts/art/model_chan_prompts.py --walk --outfit swimsuit --char claude > $W/walk_jobs.json # claude_swimsuit_walk
lh generate image -m gpt-image-2.5-sunburst -p lobehub --json "<提示词>"    # 异步：记下 generations[0].id / asyncTaskId
lh generate download <generationId> <asyncTaskId> -o $W/raw/<name>.png --timeout 900   # 偶尔会一直 pending，重新提交一次即可
for n in base_a base_b extra_a extra_b; do
  python3 scripts/art/slice_sheet.py $W/raw/claude_swimsuit_$n.png $W/sliced/claude_swimsuit_$n.png 4 2 360 --max 324x444 --smooth
  python3 scripts/art/fit_cells.py $W/sliced/claude_swimsuit_$n.png $W/fit/claude_swimsuit_$n.png 332 452 --rows 2
done
python3 scripts/art/build_model_chan_pack.py --hd --outfit swimsuit $W/fit/claude_swimsuit_base_a.png $W/fit/claude_swimsuit_base_b.png $W/fit/claude_swimsuit_extra_a.png $W/fit/claude_swimsuit_extra_b.png claude src/renderer/packs/claude-pixel   # 写 sheets/swimsuit.webp，并把它加进 pack.json 的 outfits
python3 scripts/art/slice_sheet.py $W/raw/claude_swimsuit_walk.png $W/sliced/claude_swimsuit_walk.png 4 2 360 --max 324x444 --smooth --shared-box
python3 scripts/art/fit_cells.py $W/sliced/claude_swimsuit_walk.png art/model-chan/walk/claude_swimsuit_walk.png 332 452 --rows 2
python3 scripts/art/add_walk_frames.py --from art/model-chan/walk/claude_swimsuit_walk.png --outfit swimsuit src/renderer/packs/claude-pixel   # 只写泳装图集的第 9 行
# 在 src/characters/claude.json 的 outfits 里加上 "swimsuit"
python3 scripts/art/check_model_chan.py          # 每张服饰图集的尺寸、逐帧内容、品红残留、格子边缘，以及与 daily 逐帧对齐（脚底 ≤6px、身高差 ≤12%、中心 ≤48px）；每个角色声明的服饰在默认包里都有图
xvfb-run -a node e2e/run.js outfit claude swimsuit   # 真机：升级解锁 → 衣柜换上 → idle/walk/lifted 与 daily 对齐 → 重启保留 → 旧版像素回落；截图在 out/e2e/outfit-claude-swimsuit/
```

10 套全年龄衣柜服饰（`WARDROBE`）也按这个流程生成。它们的提示词开头多一句 “Chroma-key sprite sheet … like a green screen”：只写平常的背景句时，gpt-image 常常画成深色渐变背景，抠不出来。生成后用 `scripts/art/align_outfit.py src/renderer/packs/<id>-pixel <outfit>` 把和 daily 对应帧身高差超过 11.5% 的格子以脚底为基准缩放对齐（多半是蹲着的唤醒帧），再跑 `check_model_chan.py`。

五位的沙滩比基尼 `bikini` 按同样的流程生成（`--outfit bikini`），图集是默认包里的 `sheets/bikini.webp`。gpt-image 偶尔把同一张宫格里的几格画得大一圈或小一圈，`check_model_chan.py` 会报“vs daily height”超限；这时按 daily 对应帧的身高，以脚底为基准把那几格在 fit 后的图里缩放对齐，再重建图集（2026-10-31：大肥鱼的待机、饿了、吃饼干和拎起第 2 帧，吉皮缇的唤醒第 1 帧）。

大肥鱼的提示词描述到 “ She wears ” 为止不含尾鳍，所以她的 `OUTFIT_LOOKS` 描述里另外写了尾鳍。她的原版动画（`art.kind: 'video'`）只对应 daily：外观选「原版动画」时，其他服饰用默认包 `dafeiyu-pixel` 的图集（`src/core/packs.js` `resolveLook` 跳过 clips 后按默认包、回落包查找），换回 daily 再播放视频；`xvfb-run -a node e2e/run.js outfit dafeiyu swimsuit` 会把这条路径也走一遍。她的泳装 hatch 第 1 帧（蹲姿）头顶上方有两颗离散的闪光，让身高和 daily 相差 19%，所以在 fit 后的格子里清掉了 y < 204 的这两颗闪光再建图集。

`build_model_chan_pack.py` 重建 daily 时会保留 pack.json 里其他服饰和 walk 动作；`add_walk_frames.py --from` 不写 `--outfit` 时只改 daily 的图集，所以每套服饰各自保留自己的走路帧。旧版像素包（`*-classic`）不需要新图：缺的服饰会回落到默认包。

## 来源与授权

- 克洛蒂、格萝可的身份锚点（发型、配色、服饰、标志物、主题色）取自 [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets) 的 `设定图/11_Claude娘_Anthropic`、`设定图/09_Grok娘_xAI`、`设定图/10_Gemini娘`、`设定图/02_GPT娘_白龙娘`（CC BY-NC-SA 4.0）；原始形象设计来自 ZipZipPipe《AI娘化》（[Pixiv 148186519](https://www.pixiv.net/artworks/148186519)，作者声明：可取用，需署名，不可商用）。像素图由 gpt-image-2.5 按文字提示词重新生成，没有使用 ai-chan-sheets `参考原图/` 下的未授权原图。
- 为符合 `docs/pet-packs.md` 的内容要求，四人都按成年比例绘制；吉皮缇把原设的露肩、高开衩、腿环和半透明罩衣改成了长袖、闭合的及踝长裙和不透明长罩衣，龙翼画小并收拢，白玫瑰绳结只作饰物，不画 OpenAI 标志；杰米把原设的露脐上衣、短裤和腿环改成了高领上衣、及踝长裙和不透明连裤袜，四角星只作纹样，不画 Google 标志；格萝可把原设的露肩礼服、透肉连裤袜和腿环改成了高领礼服和不透明连裤袜，像素图里不画 X 战斧和 X 字样。
- 大肥鱼沿用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的视频，授权见 `src/renderer/assets/dafeiyu/NOTICE.md`。`dafeiyu-pixel` 同样由 gpt-image-2.5 按文字提示词重画，不是从视频逐帧描摹，2026-10-29 起改为和其他四位一样的成人比例；形象（鲸鱼女仆）沿用 dsh-pet 与 ai-chan-sheets `03_DeepSeek娘_鲸鱼娘`（基于 上善无形 原创角色「溟月」，CC BY-NC-SA 4.0）。
- 因此这些像素包以 **CC BY-NC-SA 4.0** 发布：署名 ZipZipPipe（原设）、lmy414（设定补全）、rdmclin2（像素化）；**禁止商用**；改编作品须以相同协议发布。代码仍按仓库的 MIT 授权。
