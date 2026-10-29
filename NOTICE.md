# Notices

The code in this repository is MIT licensed (see [LICENSE](LICENSE)), with one exception.

## 大肥鱼 (Dafeiyu) animations: not MIT

Everything in `src/renderer/assets/dafeiyu/` and `src/renderer/assets/memes/dafeiyu/` comes from https://github.com/PC2005-cloud/dsh-pet and keeps its author's terms:

- free for open-source use, **commercial use is forbidden**;
- the character is licensed **CC BY-NC-SA 4.0**;
- derivative works must show the original repository address in public channels.

See [src/renderer/assets/dafeiyu/NOTICE.md](src/renderer/assets/dafeiyu/NOTICE.md) for the full text and credits. Any build that includes these files is for non-commercial use only. To use this project commercially, remove that folder and `src/characters/dafeiyu.json` first.

## Model-chan characters (模型娘): fan art, non-commercial

The companions are fan characters themed on AI model vendors. **None of them is an official DeepSeek, Anthropic, xAI or Google image**, and the vendors' names are used only to say what each character is inspired by. Each character is a data file in `src/characters/<id>.json` (with its own credits, shown in the app under ⋯ → 素材署名) and a pet pack in `src/renderer/packs/` (format in [docs/pet-packs.md](docs/pet-packs.md)).

- **克洛蒂 (Claude 娘) and 格萝可 (Grok 娘)** — `packs/claude-pixel/`, `packs/grok-pixel/`. Identity anchors (hair, palette, outfit, motifs, theme colour) from [lmy414/ai-chan-sheets](https://github.com/lmy414/ai-chan-sheets) `设定图/11_Claude娘_Anthropic` and `设定图/09_Grok娘_xAI` (**CC BY-NC-SA 4.0**); original designs by ZipZipPipe, 《AI娘化》 ([Pixiv 148186519](https://www.pixiv.net/artworks/148186519); the author allows use with attribution, **no commercial use**). The sprite sheets were generated from text prompts with OpenAI `gpt-image-2.5-sunburst` through LobeHub (`lh generate image`) and turned into pixel art by `scripts/art/` (prompts in `scripts/art/model_chan_prompts.py`); no image from ai-chan-sheets' unlicensed `参考原图/` folder was used. Both are drawn with adult proportions; Grok's revealing details (off-shoulder dress, sheer tights, thigh band) were replaced with a high-necked gown and opaque tights, and no X logo or lettering is drawn.
- **杰米 (Gemini 娘)** — `packs/gemini-pixel/`, added 2026-10-29 the same way: identity anchors from ai-chan-sheets `设定图/10_Gemini娘` (**CC BY-NC-SA 4.0**), original design by ZipZipPipe (《AI娘化》 p04, attribution, **no commercial use**); sprite sheets generated from text prompts with `gpt-image-2.5-sunburst` (prompts `gemini_base` / `gemini_extra` in `scripts/art/model_chan_prompts.py`) and pixelated by `scripts/art/` (`fit_cells.py --keep-violet`). Drawn with adult proportions; the original crop top, shorts and thigh band were replaced with a high-necked top, an ankle-length skirt and opaque tights. The four-pointed star is used only as a pattern; no Google logo or lettering is drawn.
- **大肥鱼 (Dafeiyu, DeepSeek 娘)** — besides the dsh-pet animations above, `packs/dafeiyu-illustrated/` (8 outfit pictures) and `packs/dafeiyu-pixel/` (a pixel version of the same chibi maid, redrawn from text prompts, not traced from the videos) depict the community character, so they keep its terms.
- **Memes (梗图).** `src/renderer/assets/memes/<character>/` holds each character's meme stickers. 大肥鱼's nine are from dsh-pet (terms above). 克洛蒂's, 格萝可's and 杰米's (four each) were generated on 2026-10-29 with `gpt-image-2.5-sunburst` as one 2×2 sticker sheet per character from text prompts using the same identity anchors as their packs, then cut into WebP; they are **CC BY-NC-SA 4.0, non-commercial** like the packs.
- **License of this art.** Everything in `src/renderer/packs/` is released under **CC BY-NC-SA 4.0**: attribution to ZipZipPipe (original designs), lmy414 (character sheets) and rdmclin2 (pixel art), **non-commercial only**, adaptations under the same license. The code stays MIT. Any build that contains these packs is for non-commercial use only; to use this project commercially, replace the characters with your own (a character file plus a pet pack each) and remove `src/renderer/assets/dafeiyu/`.
- **Retired art.** The original companions (焰团, 泡鲸, 叶芽), their packs and the procedural spirit stones were removed with the model-chan roster; old saves are taken over by a current character (see `src/core/species.js`).
- **App icon.** `build/icon.png` shows the three model-chan in pixel style; generated on 2026-10-29 with `gpt-image-2.5-sunburst` (prompt `logo` in `scripts/art/prompts.py`). It depicts the same fan characters, so it is **CC BY-NC-SA 4.0, non-commercial** like the packs. (The earlier icon showed a retired character and was replaced.)

Content notes: every character's set age is 25+. Claude, Grok and Gemini are drawn with adult proportions; 大肥鱼 keeps the community character's chibi style and is therefore all-ages only, like the others. No picture shows nudity or underwear. Adult-rated outfits (maid, off-shoulder gown, retro swimsuit, silk robe) exist in the app but no current character has art for them or allows adult content, so they are never shown.

| id | 名称 | 解锁阶段 | 分级 | 美术 |
| --- | --- | --- | --- | --- |
| `daily` | 日常服（每位角色的原设服装） | 陌生 | 全年龄 | 大肥鱼：原版动画（或像素包）；克洛蒂、格萝可：像素包 |
| `scarf` | 针织围巾套装 | 陌生 | 全年龄 | 大肥鱼立绘 |
| `casual` | 休闲卫衣 | 熟悉 | 全年龄 | 大肥鱼立绘 |
| `beret` | 贝雷帽画家装 | 熟悉 | 全年龄 | 大肥鱼立绘 |
| `pajamas` | 毛绒睡衣 | 亲近 | 全年龄 | 大肥鱼立绘 |
| `cat_ears` | 猫耳家居服 | 亲近 | 全年龄 | 大肥鱼立绘 |
| `yukata` | 浴衣 | 暧昧 / 知己 | 全年龄 | 大肥鱼立绘 |
| `couple_hoodie` | 情侣卫衣 | 恋人 / 挚友 | 全年龄 | 大肥鱼立绘 |
| `flower_crown` | 花冠长裙 | 恋人 / 挚友 | 全年龄 | 大肥鱼立绘 |
| `maid` / `offshoulder_gown` / `retro_swimsuit` / `silk_robe` | 成人向服饰 | 暧昧 / 恋人 | 成人向 | 当前角色均无（不显示） |
