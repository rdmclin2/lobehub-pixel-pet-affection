# Notices

The code in this repository is MIT licensed (see [LICENSE](LICENSE)), with one exception.

## 大肥鱼 (Dafeiyu) animations: not MIT

Everything in `src/renderer/assets/dafeiyu/` comes from https://github.com/PC2005-cloud/dsh-pet and keeps its author's terms:

- free for open-source use, **commercial use is forbidden**;
- the character is licensed **CC BY-NC-SA 4.0**;
- derivative works must show the original repository address in public channels.

See [src/renderer/assets/dafeiyu/NOTICE.md](src/renderer/assets/dafeiyu/NOTICE.md) for the full text and credits. Any build that includes these files is for non-commercial use only. To use this project commercially, remove that folder and the `dafeiyu` entry in `src/core/species.js` first.

## Character and outfit pictures (角色与服饰立绘): generated for this project

Every companion is shown as a picture per outfit: `src/renderer/assets/chars/<species>/<outfit>.webp`. The same picture is used on the desktop and in the wardrobe, so changing clothes changes what you see. The app icon `build/icon.png` was made the same way.

- **How they were made.** Generated on 2026-10-28 with OpenAI `gpt-image-2.5-sunburst` through LobeHub (`lh generate image`), one prompt per character and outfit, then cut out from a flat magenta background, cropped and scaled (`scripts/art/`). The prompts are in [scripts/art/prompts.py](scripts/art/prompts.py) so the set can be regenerated.
- **License.** The pictures of the three original companions (焰团 embit, 泡鲸 bubbo, 叶芽 sprig) and the icon are released under MIT with the code. No third-party images, sprite sheets or fonts are included.
- **大肥鱼 (Dafeiyu) pictures** (`assets/chars/dafeiyu/`) depict the community character above, so they are a derivative work and keep its terms: **CC BY-NC-SA 4.0, no commercial use**, credit to https://github.com/PC2005-cloud/dsh-pet. Its signature outfit is still its original animation.

Content notes: every picture shows an adult woman (the characters' set age is 25+, adult proportions, no chibi or childlike styling). No picture shows nudity or underwear. The adult-rated outfits differ in style only: a knee-length long-sleeved maid dress, a floor-length off-shoulder gown with a high neckline, a retro one-piece swimsuit worn with a knee-length wrap skirt, and a knee-length belted robe over long pajama pants. Adult-rated outfits are hidden unless the user confirmed 18+ and turned adult content on, and are never offered for 大肥鱼.

| id | 名称 | 解锁阶段 | 分级 | 立绘 |
| --- | --- | --- | --- | --- |
| `daily` | 日常服（大肥鱼：招牌女仆装，原版动画） | 陌生 | 全年龄 | 4 位角色各一张（大肥鱼用动画） |
| `scarf` | 针织围巾套装 | 陌生 | 全年龄 | 4 位角色各一张 |
| `casual` | 休闲卫衣 | 熟悉 | 全年龄 | 4 位角色各一张 |
| `beret` | 贝雷帽画家装 | 熟悉 | 全年龄 | 4 位角色各一张 |
| `pajamas` | 毛绒睡衣 | 亲近 | 全年龄 | 4 位角色各一张 |
| `cat_ears` | 猫耳家居服 | 亲近 | 全年龄 | 4 位角色各一张 |
| `yukata` | 浴衣 | 暧昧 / 知己 | 全年龄 | 4 位角色各一张 |
| `maid` | 女仆装 | 暧昧 | 成人向 | 3 位原创角色各一张 |
| `offshoulder_gown` | 露肩晚礼服 | 暧昧 | 成人向 | 3 位原创角色各一张 |
| `couple_hoodie` | 情侣卫衣 | 恋人 / 挚友 | 全年龄 | 4 位角色各一张 |
| `flower_crown` | 花冠长裙 | 恋人 / 挚友 | 全年龄 | 4 位角色各一张 |
| `retro_swimsuit` | 复古连体泳装 | 恋人 | 成人向 | 3 位原创角色各一张 |
| `silk_robe` | 丝绸睡袍 | 恋人 | 成人向 | 3 位原创角色各一张 |
