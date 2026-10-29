# Part of scripts/art/pixel-pack.sh.
# usage: slice.py <sheet.png> <out.png> <cols> <rows> <figure_height_px> [--octree]
#   --octree: build the palette with fast octree instead of median cut, for a near-white character (GPT):
#   median cut spends every colour on her whites and lavenders and maps small props (watermelon, cookie)
#   and skin to a magenta tone that fit_cells.py then deletes as background.
# Cut a generated sprite sheet (flat magenta background, equal grid) into frames, make them real pixel
# art (downscale + limited palette + hard alpha) and write a normalized sheet: every cell the same size,
# figures keep their placement within the cell (one shared crop box), so frames line up when animated.
import sys
from collections import deque
import numpy as np
from PIL import Image

octree = '--octree' in sys.argv
argv = [x for x in sys.argv if x != '--octree']
src, dst, cols, rows, fig_h = argv[1], argv[2], int(argv[3]), int(argv[4]), int(argv[5])
im = Image.open(src).convert('RGB')
W, H = im.size
cw, ch = W / cols, H / rows

def alpha_of(cell):
    a = np.asarray(cell).astype(np.int32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    key = np.minimum(r, b) - g
    bg = key > 60
    h, w = bg.shape
    seen = np.zeros_like(bg)
    q = deque([(y, x) for x in range(w) for y in (0, h - 1) if bg[y, x]] + [(y, x) for y in range(h) for x in (0, w - 1) if bg[y, x]])
    for y, x in q: seen[y, x] = True
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and bg[ny, nx]:
                seen[ny, nx] = True; q.append((ny, nx))
    fg = ~(seen | (key > 140))
    # drop pieces of the neighbouring cells: small bits that touch this cell's border (the figure itself
    # may touch the border too, so only bits much smaller than the biggest piece go)
    lab = np.zeros(fg.shape, np.int32)
    n = 0
    pieces = []
    for sy, sx in zip(*np.nonzero(fg)):
        if lab[sy, sx]: continue
        n += 1
        lab[sy, sx] = n
        stack, border = [(sy, sx)], False
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            if y in (0, h - 1) or x in (0, w - 1): border = True
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = n; stack.append((ny, nx))
        pieces.append((border, comp))
    big = max((len(c) for _, c in pieces), default=0)
    for border, comp in pieces:
        if border and len(comp) < big * 0.2:
            for y, x in comp: fg[y, x] = False
    return fg

cells, boxes = [], []
for j in range(rows):
    for i in range(cols):
        c = im.crop((round(i * cw), round(j * ch), round((i + 1) * cw), round((j + 1) * ch)))
        fg = alpha_of(c)
        ys, xs = np.nonzero(fg)
        cells.append((c, fg))
        boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1) if len(xs) else None)
valid = [b for b in boxes if b]
box = (min(b[0] for b in valid), min(b[1] for b in valid), max(b[2] for b in valid), max(b[3] for b in valid))
# scale so a typical standing figure (median height) becomes fig_h pixels tall
med_h = sorted(b[3] - b[1] for b in valid)[len(valid) // 2]
s = fig_h / med_h
out_w, out_h = max(1, round((box[2] - box[0]) * s)), max(1, round((box[3] - box[1]) * s))
frames = []
for c, fg in cells:
    rgba = np.dstack([np.asarray(c), (fg * 255).astype(np.uint8)])
    f = Image.fromarray(rgba, 'RGBA').crop(box)
    rgb = f.convert('RGB').resize((out_w, out_h), Image.BOX)
    a = f.getchannel('A').resize((out_w, out_h), Image.BOX).point(lambda v: 255 if v >= 128 else 0)
    frames.append((rgb, a))
# one palette for the whole sheet keeps colours steady between frames
strip = Image.new('RGB', (out_w * len(frames), out_h))
for k, (rgb, _) in enumerate(frames): strip.paste(rgb, (k * out_w, 0))
pal = strip.quantize(colors=40, method=Image.Quantize.FASTOCTREE if octree else Image.MEDIANCUT, dither=Image.Dither.NONE)
sheet = Image.new('RGBA', (out_w * cols, out_h * rows), (0, 0, 0, 0))
for k, (rgb, a) in enumerate(frames):
    q = rgb.quantize(palette=pal, dither=Image.Dither.NONE).convert('RGBA')
    q.putalpha(a)
    sheet.paste(q, ((k % cols) * out_w, (k // cols) * out_h))
sheet.save(dst, optimize=True)
print(dst, 'cell', out_w, out_h, 'sheet', sheet.size)
