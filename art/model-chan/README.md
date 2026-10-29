# 模型娘 · 首批角色素材

以 AI 模型厂商为主题的同人“模型娘”形象，**不是厂商官方形象**。设定文档见 [`CHARACTERS.md`](CHARACTERS.md)，设计记录在 [`characters.json`](characters.json)。应用实际读取的角色数据在 `src/characters/<id>.json`，像素包在 `src/renderer/packs/<id>-pixel/`。

| 角色 | 厂商 | 主题色 | 美术 | 素材位置 |
| --- | --- | --- | --- | --- |
| 大肥鱼（DeepSeek 娘，Q 版鲸鱼女仆） | DeepSeek | `#2C4A8A` | 保留原有 15 段透明视频；另出同一 Q 版女仆形象的像素版 | `src/renderer/assets/dafeiyu/`、`src/renderer/packs/dafeiyu-pixel/` |
| 克洛蒂（Claude 娘，橘发菊纹） | Anthropic | `#C4622D` | 像素精灵图 | `src/renderer/packs/claude-pixel/` |
| 格萝可（Grok 娘，黑金吸血鬼） | xAI | `#8E1F33` | 像素精灵图 | `src/renderer/packs/grok-pixel/` |
| 杰米（Gemini 娘，四角星猫耳；第二批，2026-10-29） | Google | `#7B5CD6` | 像素精灵图 | `src/renderer/packs/gemini-pixel/` |
| 吉皮缇（GPT 娘，白龙；第三批，2026-10-29） | OpenAI | `#8E7FC8` | 像素精灵图 | `src/renderer/packs/gpt-pixel/` |

预览拼图：[`preview/model-chan-preview.png`](preview/model-chan-preview.png)。第一行是大肥鱼原视频的参考帧，下面五行是五个像素包，每列一个状态、每格该状态的 2 帧。

## 像素包格式

schema 2（见 `docs/pet-packs.md`）：RGBA PNG，单帧 83×113，一张 4 列 × 8 行（332×904），16 个动作各 2 帧，动作名就是共享效果层的状态名（大肥鱼视频的 15 个状态 + `lifted`）。

## 重新生成

需要已登录的 `lh`、带 Pillow 和 numpy 的 python3、带 libvpx-vp9 的 ffmpeg。

```bash
python3 scripts/art/model_chan_prompts.py > jobs.json          # 每个角色 2 条提示词：<id>_base、<id>_extra
lh generate image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"  # 每条生成一张 4×4 宫格
python3 scripts/art/slice_sheet.py raw/<name>.png sliced/<name>.png 4 4 96   # 抠图、像素化、限制调色板（吉皮缇这类白色角色加 --octree，否则西瓜、饼干和肤色会被并进品红色调后删掉）
python3 scripts/art/fit_cells.py sliced/<name>.png fit/<name>.png           # 放进 83×113 的格子，去品红边（杰米这类紫色发色加 --keep-violet）
python3 scripts/art/build_model_chan_pack.py fit/<id>_base.png fit/<id>_extra.png <id> src/renderer/packs/<id>-pixel
python3 scripts/art/check_model_chan.py                       # 校验尺寸、格式、每个动作的每一帧都有内容
python3 scripts/art/model_chan_preview.py art/model-chan/preview/model-chan-preview.png
```

## 来源与授权

- 克洛蒂、格萝可的身份锚点（发型、配色、服饰、标志物、主题色）取自 [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets) 的 `设定图/11_Claude娘_Anthropic`、`设定图/09_Grok娘_xAI`、`设定图/10_Gemini娘`、`设定图/02_GPT娘_白龙娘`（CC BY-NC-SA 4.0）；原始形象设计来自 ZipZipPipe《AI娘化》（[Pixiv 148186519](https://www.pixiv.net/artworks/148186519)，作者声明：可取用，需署名，不可商用）。像素图由 gpt-image-2.5 按文字提示词重新生成，没有使用 ai-chan-sheets `参考原图/` 下的未授权原图。
- 为符合 `docs/pet-packs.md` 的内容要求，四人都按成年比例绘制；吉皮缇把原设的露肩、高开衩、腿环和半透明罩衣改成了长袖、闭合的及踝长裙和不透明长罩衣，龙翼画小并收拢，白玫瑰绳结只作饰物，不画 OpenAI 标志；杰米把原设的露脐上衣、短裤和腿环改成了高领上衣、及踝长裙和不透明连裤袜，四角星只作纹样，不画 Google 标志；格萝可把原设的露肩礼服、透肉连裤袜和腿环改成了高领礼服和不透明连裤袜，像素图里不画 X 战斧和 X 字样。
- 大肥鱼沿用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的视频，授权见 `src/renderer/assets/dafeiyu/NOTICE.md`。`dafeiyu-pixel` 同样由 gpt-image-2.5 按文字提示词重画，不是从视频逐帧描摹；形象（Q 版鲸鱼女仆）沿用 dsh-pet 与 ai-chan-sheets `03_DeepSeek娘_鲸鱼娘`（基于 上善无形 原创角色「溟月」，CC BY-NC-SA 4.0）。
- 因此这些像素包以 **CC BY-NC-SA 4.0** 发布：署名 ZipZipPipe（原设）、lmy414（设定补全）、rdmclin2（像素化）；**禁止商用**；改编作品须以相同协议发布。代码仍按仓库的 MIT 授权。
