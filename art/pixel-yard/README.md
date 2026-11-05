# 像素小院 · 美术

小游戏「像素小院」（`catalog/games/pixel-yard/`，docs/mini-games.md §8）的美术源。

| 文件 | 是什么 |
| --- | --- |
| `prompts.json` | 每张 GPT Image（gpt-image-2.5）原图的提示词与尺寸，带统一的风格句 |
| `layout.json` | 切图：每个精灵来自哪张原图的哪个框、缩放多少 |
| `raw/*.webp` | 原图（无损 WebP，约 10 MB）。不进仓库：源是 CDN 上的 `games-v1/pixel-yard-art.zip` |

```bash
# 取回原图（或者按 prompts.json 重新生成）
curl -fL -o /tmp/pixel-yard-art.zip https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/games-v1/pixel-yard-art.zip
unzip -o /tmp/pixel-yard-art.zip -d art/pixel-yard/raw
# 由原图重建包里的 terrain.webp / atlas.webp / sprites.json（结果逐字节一致）
python3 scripts/art/game_sprites.py build art/pixel-yard/layout.json art/pixel-yard/raw catalog/games/pixel-yard
```
