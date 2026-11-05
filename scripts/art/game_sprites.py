#!/usr/bin/env python3
"""小游戏包的美术 (docs/mini-games.md §8): GPT Image sheets → a game pack's pictures.

  python3 scripts/art/game_sprites.py find  <sheet.png>                       # list the sprites found on a magenta sheet
  python3 scripts/art/game_sprites.py build <layout.json> <raw-dir> <pack-dir> # cut, scale and pack them (+ sprites.json)

The 像素小院 pack: build art/pixel-yard/layout.json art/pixel-yard/raw catalog/games/pixel-yard (raw = the GPT
Image sheets as lossless WebP; prompts in art/pixel-yard/prompts.json).

A sheet is drawn on flat magenta (#FF00FF); `find` keys the magenta out, groups the opaque pixels into blobs
(pieces closer than --gap px are one sprite) and prints each blob's box in sheet px, biggest first, so the layout
can name them. `build` reads art/<game>/layout.json:

  { "terrain": { "sheet": "terrain", "scale": 0.5, "key": "black" },          # the world picture
    "sprites": { "<name>": { "sheet": "trees", "box": [x, y, w, h], "scale": 0.24 } … } }

and writes <pack-dir>/terrain.webp, <pack-dir>/atlas.webp (every sprite, shelf-packed, 2 px apart) and
<pack-dir>/sprites.json ({ name: { x, y, w, h } } in atlas px). Scaling is a box filter (no blur from
over-sampling), the alpha is cut hard at 50% and magenta left on the edges is pulled back to the neighbours.
Needs Pillow and numpy.
"""
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image


def magenta_mask(a):
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    return (r > 150) & (b > 150) & (g < 120) & (np.abs(r - b) < 90)


def key_sheet(im, key="magenta"):
    a = np.array(im.convert("RGBA"))
    if key == "black":
        bg = (a[..., 0] < 18) & (a[..., 1] < 18) & (a[..., 2] < 18)
    else:
        bg = magenta_mask(a)
        # pinkish fringe next to the background: magenta bled into the edge pixels
        r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
        fringe = (np.minimum(r, b) - g > 60) & ~bg
        bg = bg | fringe
    a[bg, 3] = 0
    return Image.fromarray(a)


def blobs(im, gap=12, min_px=400):
    a = np.array(im)[..., 3] > 0
    k = 4
    h, w = a.shape
    small = a[: h // k * k, : w // k * k].reshape(h // k, k, w // k, k).any(axis=(1, 3))
    g = max(1, gap // k)
    # dilate by g cells so nearby pieces join
    dil = small.copy()
    for dy in range(-g, g + 1):
        for dx in range(-g, g + 1):
            dil |= np.roll(np.roll(small, dy, 0), dx, 1)
    H, W = dil.shape
    seen = np.zeros_like(dil, dtype=bool)
    out = []
    for y in range(H):
        for x in range(W):
            if not dil[y, x] or seen[y, x]:
                continue
            q = deque([(y, x)])
            seen[y, x] = True
            cells = []
            while q:
                cy, cx = q.popleft()
                cells.append((cy, cx))
                for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                    if 0 <= ny < H and 0 <= nx < W and dil[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            ys = [c[0] for c in cells if small[c]]
            xs = [c[1] for c in cells if small[c]]
            if not ys:
                continue
            x0, y0, x1, y1 = min(xs) * k, min(ys) * k, (max(xs) + 1) * k, (max(ys) + 1) * k
            n = int(a[y0:y1, x0:x1].sum())
            if n >= min_px:
                out.append({"box": [x0, y0, x1 - x0, y1 - y0], "px": n})
    out.sort(key=lambda b: (b["box"][1] // 200, b["box"][0]))
    return out


def scale_sprite(im, s):
    w, h = im.size
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    a = np.array(im).astype(np.float32)
    # premultiply so transparent pixels do not darken the edges
    a[..., :3] *= a[..., 3:4] / 255.0
    pm = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    out = np.array(pm.resize((nw, nh), Image.BOX)).astype(np.float32)
    al = out[..., 3:4]
    rgb = np.where(al > 0, out[..., :3] * 255.0 / np.maximum(al, 1), 0)
    alpha = np.where(al[..., 0] >= 128, 255, 0)
    res = np.dstack([rgb, alpha]).clip(0, 255).astype(np.uint8)
    return Image.fromarray(res)


def trim(im):
    bb = im.getbbox()
    return im.crop(bb) if bb else im


def pack(sprites, width=2048, pad=2):
    items = sorted(sprites.items(), key=lambda kv: -kv[1].size[1])
    x = y = shelf = 0
    pos = {}
    for name, im in items:
        w, h = im.size
        if x + w > width:
            x = 0
            y += shelf + pad
            shelf = 0
        pos[name] = (x, y, w, h)
        x += w + pad
        shelf = max(shelf, h)
    H = y + shelf
    atlas = Image.new("RGBA", (width, H), (0, 0, 0, 0))
    for name, im in items:
        x, y, w, h = pos[name]
        atlas.paste(im, (x, y))
    return atlas, {n: {"x": p[0], "y": p[1], "w": p[2], "h": p[3]} for n, p in pos.items()}


def main():
    cmd = sys.argv[1]
    if cmd == "find":
        im = key_sheet(Image.open(sys.argv[2]))
        gap = int(sys.argv[3]) if len(sys.argv) > 3 else 12
        for i, b in enumerate(blobs(im, gap)):
            print(i, b["box"], b["px"])
        return
    layout = json.load(open(sys.argv[2]))
    raw, dest = sys.argv[3], sys.argv[4]
    os.makedirs(dest, exist_ok=True)
    sheets = {}

    def src(name):
        for ext in (".png", ".webp"):
            f = os.path.join(raw, name + ext)
            if os.path.exists(f):
                return Image.open(f)
        raise SystemExit(f"no {name}.png / .webp in {raw}")

    def sheet(name, key="magenta"):
        if (name, key) not in sheets:
            sheets[(name, key)] = key_sheet(src(name), key)
        return sheets[(name, key)]

    t = layout["terrain"]
    terr = src(t["sheet"]).convert("RGBA")
    if t.get("key"):
        terr = key_sheet(terr, t["key"])
    terr = scale_sprite(terr, t.get("scale", 1))
    terr.save(os.path.join(dest, "terrain.webp"), "WEBP", lossless=True, method=6)
    sprites = {}
    for name, spec in layout["sprites"].items():
        x, y, w, h = spec["box"]
        im = sheet(spec["sheet"], spec.get("key", "magenta")).crop((x, y, x + w, y + h))
        sprites[name] = trim(scale_sprite(trim(im), spec["scale"]))
    atlas, boxes = pack(sprites)
    atlas.save(os.path.join(dest, "atlas.webp"), "WEBP", lossless=True, method=6)
    json.dump(boxes, open(os.path.join(dest, "sprites.json"), "w"), indent=1, sort_keys=True)
    print(f"terrain {terr.size}  atlas {atlas.size}  sprites {len(boxes)}")


if __name__ == "__main__":
    main()
