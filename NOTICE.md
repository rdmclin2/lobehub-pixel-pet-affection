# Notices

The code in this repository is MIT licensed (see [LICENSE](LICENSE)), with one exception.

## 大肥鱼 (Dafeiyu) animations: not MIT

Everything in `src/renderer/assets/dafeiyu/` comes from https://github.com/PC2005-cloud/dsh-pet and keeps its author's terms:

- free for open-source use, **commercial use is forbidden**;
- the character is licensed **CC BY-NC-SA 4.0**;
- derivative works must show the original repository address in public channels.

See [src/renderer/assets/dafeiyu/NOTICE.md](src/renderer/assets/dafeiyu/NOTICE.md) for the full text and credits. Any build that includes these files is for non-commercial use only. To use this project commercially, remove that folder and the `dafeiyu` entry in `src/core/species.js` first.

## Outfit art (服饰素材): made for this project, MIT

Every outfit in the wardrobe is original pixel art drawn for this repository. No third-party images, sprite sheets, fonts or generated images are used. The art is code: `OUTFIT_ART` and the adult figure template `FIG_HALF` in [src/renderer/sprites.js](src/renderer/sprites.js) describe each pixel, and the app draws them at run time. The outfit table (id, name, stage, rating, art path) is `OUTFITS` in [src/core/outfits.js](src/core/outfits.js).

| id | 名称 | 解锁阶段 | 分级 | 来源 | 许可 |
| --- | --- | --- | --- | --- | --- |
| `daily` | 日常服 | 陌生 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.daily`） | MIT，可商用、可再分发 |
| `scarf` | 针织围巾套装 | 陌生 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.scarf`） | MIT，可商用、可再分发 |
| `casual` | 休闲卫衣 | 熟悉 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.casual`） | MIT，可商用、可再分发 |
| `beret` | 贝雷帽画家装 | 熟悉 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.beret`） | MIT，可商用、可再分发 |
| `pajamas` | 毛绒睡衣 | 亲近 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.pajamas`） | MIT，可商用、可再分发 |
| `cat_ears` | 猫耳家居服 | 亲近 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.cat_ears`） | MIT，可商用、可再分发 |
| `yukata` | 浴衣 | 暧昧 / 知己 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.yukata`） | MIT，可商用、可再分发 |
| `maid` | 女仆装 | 暧昧 | 成人向 | 本项目自制（`sprites.js#OUTFIT_ART.maid`） | MIT，可商用、可再分发 |
| `offshoulder_gown` | 露肩晚礼服 | 暧昧 | 成人向 | 本项目自制（`sprites.js#OUTFIT_ART.offshoulder_gown`） | MIT，可商用、可再分发 |
| `couple_hoodie` | 情侣卫衣 | 恋人 / 挚友 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.couple_hoodie`） | MIT，可商用、可再分发 |
| `flower_crown` | 花冠长裙 | 恋人 / 挚友 | 全年龄 | 本项目自制（`sprites.js#OUTFIT_ART.flower_crown`） | MIT，可商用、可再分发 |
| `retro_swimsuit` | 复古连体泳装 | 恋人 | 成人向 | 本项目自制（`sprites.js#OUTFIT_ART.retro_swimsuit`） | MIT，可商用、可再分发 |
| `silk_robe` | 丝绸睡袍 | 恋人 | 成人向 | 本项目自制（`sprites.js#OUTFIT_ART.silk_robe`） | MIT，可商用、可再分发 |

Content notes: every figure is an adult (about 6.5 heads tall; the characters' set age is 25+). No outfit shows nudity or underwear; the adult-rated ones differ in style only (a knee-length long-sleeved maid dress, a floor-length off-shoulder gown, a retro one-piece swimsuit with shorts-cut legs, a knee-length belted robe). Adult-rated outfits are hidden unless the user confirmed 18+ and turned adult content on, and are never offered for 大肥鱼 (Dafeiyu), whose art is third-party and cannot be dressed.
