# 模型娘 · 首批角色素材

以 AI 模型厂商为主题的同人“模型娘”形象，**不是厂商官方形象**。设定文档见 [`CHARACTERS.md`](CHARACTERS.md)，设定数据在 [`characters.json`](characters.json)（字段与 `src/core/species.js` 对齐），像素素材在 `packs/`。

| 角色 | 厂商 | 主题色 | 美术 | 素材位置 |
| --- | --- | --- | --- | --- |
| 大肥鱼（DeepSeek 娘，Q 版鲸鱼女仆） | DeepSeek | `#2C4A8A` | 保留原有 15 段透明视频；另出同一 Q 版女仆形象的像素版 | `src/renderer/assets/dafeiyu/`、`packs/dafeiyu-pixel/` |
| 克洛蒂（Claude 娘，橘发菊纹） | Anthropic | `#C4622D` | 像素精灵图 | `packs/claude-pixel/` |
| 格萝可（Grok 娘，黑金吸血鬼） | xAI | `#8E1F33` | 像素精灵图 | `packs/grok-pixel/` |

预览拼图：[`preview/model-chan-preview.png`](preview/model-chan-preview.png)。第一行是大肥鱼原视频的参考帧，下面三行是三个像素包，每列一个状态、每格该状态的 2 帧。

## 像素包格式

和内置的 `bubbo-pixel` 完全一致：RGBA PNG，单帧 83×113，每张图 4 列 × 4 行（332×452），每个动作 2 帧。

- `sheets/daily.png` 放 schema 1 的 8 个动作（idle、wave、lifted、eat、sleep、think、talk、cheer），排布写在 `pack.json` 里，现有加载器能直接播放。
- `sheets/daily_extra.png` 放大肥鱼视频独有的 8 个状态（look、sad、hungry、eat_cookie、eat_fruit、play、hatch、evolve），排布写在 `actions-extra.json` 里。schema 1 不认识这些动作名，所以单独放一个文件，等包格式扩展时再并入。
- `actions-extra.json` 的 `clips` 字段把大肥鱼的 15 个视频状态逐一对应到像素动作（happy → cheer，pat → wave，eat_rice → eat，其余同名），`lifted` 只有像素角色有。

这三个包暂存在这里，还没放进 `src/renderer/packs/`：`claude-pixel`、`grok-pixel` 的 `species`（`claude`、`grok`）要等角色注册进 `src/core/species.js` 之后才能通过校验，否则内置包测试会失败；`dafeiyu` 已注册，`dafeiyu-pixel` 随时可以搬，但和另外两个一起接入，免得大肥鱼的外观选择先变。注册后整个目录 `git mv` 过去就能用。

## 重新生成

需要已登录的 `lh`、带 Pillow 和 numpy 的 python3、带 libvpx-vp9 的 ffmpeg。

```bash
python3 scripts/art/model_chan_prompts.py > jobs.json          # 每个角色 2 条提示词：<id>_base、<id>_extra
lh generate image -m gpt-image-2.5-sunburst -p lobehub "<提示词>"  # 每条生成一张 4×4 宫格
python3 scripts/art/slice_sheet.py raw/<name>.png sliced/<name>.png 4 4 96   # 抠图、像素化、限制调色板
python3 scripts/art/fit_cells.py sliced/<name>.png fit/<name>.png           # 放进 83×113 的格子，去品红边
python3 scripts/art/build_model_chan_pack.py fit/<id>_base.png fit/<id>_extra.png <id> art/model-chan/packs/<id>-pixel
python3 scripts/art/check_model_chan.py                       # 校验尺寸、格式、每个动作的每一帧都有内容
python3 scripts/art/model_chan_preview.py art/model-chan/preview/model-chan-preview.png
```

## 来源与授权

- 克洛蒂、格萝可的身份锚点（发型、配色、服饰、标志物、主题色）取自 [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets) 的 `设定图/11_Claude娘_Anthropic`、`设定图/09_Grok娘_xAI`（CC BY-NC-SA 4.0）；原始形象设计来自 ZipZipPipe《AI娘化》（[Pixiv 148186519](https://www.pixiv.net/artworks/148186519)，作者声明：可取用，需署名，不可商用）。像素图由 gpt-image-2.5 按文字提示词重新生成，没有使用 ai-chan-sheets `参考原图/` 下的未授权原图。
- 为符合 `docs/pet-packs.md` 的内容要求，两人都按成年比例绘制；格萝可把原设的露肩礼服、透肉连裤袜和腿环改成了高领礼服和不透明连裤袜，像素图里不画 X 战斧和 X 字样。
- 大肥鱼沿用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的视频，授权见 `src/renderer/assets/dafeiyu/NOTICE.md`。`dafeiyu-pixel` 同样由 gpt-image-2.5 按文字提示词重画，不是从视频逐帧描摹；形象（Q 版鲸鱼女仆）沿用 dsh-pet 与 ai-chan-sheets `03_DeepSeek娘_鲸鱼娘`（基于 上善无形 原创角色「溟月」，CC BY-NC-SA 4.0）。
- 因此 `packs/` 下的美术以 **CC BY-NC-SA 4.0** 发布：署名 ZipZipPipe（原设）、lmy414（设定补全）、rdmclin2（像素化）；**禁止商用**；改编作品须以相同协议发布。代码仍按仓库的 MIT 授权。
