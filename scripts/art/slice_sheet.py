# Part of scripts/art/pixel-pack.sh.
# usage: slice.py <sheet.png> <out.png> <cols> <rows> <figure_height_px> [--octree] [--max WxH]
#   --key green: the sheet was generated on pure green (#00FF00) instead of magenta, for a character whose
#   colours are close to magenta (Gemini's pink-violet hair tips get keyed out on magenta)
#   --shared-box: crop every cell with one box for the whole sheet (the old behaviour). By default each action
#   (two neighbouring cells, the model-chan layout) gets its own box and stands on the bottom of its cell, so a
#   figure drawn lower in one cell does not leave the standing frames floating above the floor.
#   --max WxH: scale down further when needed so a frame fits a W x H cell (fit_cells.py then only centres it)
#   --octree: build the palette with fast octree instead of median cut, for a near-white character (GPT):
#   median cut spends every colour on her whites and lavenders and maps small props (watermelon, cookie)
#   and skin to a magenta tone that fit_cells.py then deletes as background.
# Cut a generated sprite sheet (flat magenta background, or a transparent one, equal grid) into frames, make them real pixel
# art (downscale + limited palette + hard alpha) and write a normalized sheet: every cell the same size,
# figures keep their placement within the cell (one shared crop box), so frames line up when animated.
import sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

octree = '--octree' in sys.argv
shared_box = '--shared-box' in sys.argv
argv = [x for x in sys.argv if x not in ('--octree', '--shared-box')]
green = False
if '--key' in argv:
    i = argv.index('--key')
    green = argv[i + 1] == 'green'
    del argv[i:i + 2]
max_wh = None
if '--max' in argv:
    i = argv.index('--max')
    max_wh = tuple(int(v) for v in argv[i + 1].split('x'))
    del argv[i:i + 2]
src, dst, cols, rows, fig_h = argv[1], argv[2], int(argv[3]), int(argv[4]), int(argv[5])
src_im = Image.open(src)
# gpt-image-2.5 may answer with a transparent background instead of the magenta asked for: then the
# alpha channel is the mask (its soft glow is cut at half opacity) and the magenta key is not used
src_a = np.asarray(src_im.convert('RGBA'))[..., 3] if src_im.mode in ('RGBA', 'LA', 'P') else None
if src_a is not None and (src_a < 128).mean() < 0.2: src_a = None
im = src_im.convert('RGB')
W, H = im.size
cw, ch = W / cols, H / rows

def alpha_of(cell, mask=None):
    a = np.asarray(cell).astype(np.int32)
    if mask is not None: return drop_strays(mask >= 128)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    key = g - np.maximum(r, b) if green else np.minimum(r, b) - g
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
    # the generator blends the figure's edge into the magenta for a few pixels: peel that rim off
    fg = np.asarray(Image.fromarray(fg.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(5))) > 0
    return drop_strays(fg)

def drop_strays(fg):
    h, w = fg.shape
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
        x0, y0, x1, y1 = round(i * cw), round(j * ch), round((i + 1) * cw), round((j + 1) * ch)
        c = im.crop((x0, y0, x1, y1))
        fg = alpha_of(c, None if src_a is None else src_a[y0:y1, x0:x1])
        ys, xs = np.nonzero(fg)
        cells.append((c, fg))
        boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1) if len(xs) else None)
valid = [b for b in boxes if b]
union = lambda bs: (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))
# the crop box of every cell: one for the sheet, or one per action (its two frames keep their relative motion)
group = len(boxes) if shared_box else 2
cell_box = []
for g in range(0, len(boxes), group):
    bs = [b for b in boxes[g:g + group] if b]
    cell_box += [union(bs) if bs else None] * len(boxes[g:g + group])
# scale so a typical standing figure (median height) becomes fig_h pixels tall
med_h = sorted(b[3] - b[1] for b in valid)[len(valid) // 2]
s = fig_h / med_h
big_w = max(b[2] - b[0] for b in cell_box if b)
big_h = max(b[3] - b[1] for b in cell_box if b)
if max_wh: s = min(s, max_wh[0] / big_w, max_wh[1] / big_h)
out_w, out_h = max(1, round(big_w * s)), max(1, round(big_h * s))
frames = []
for (c, fg), box in zip(cells, cell_box):
    if box is None:
        frames.append((Image.new('RGB', (out_w, out_h)), Image.new('L', (out_w, out_h), 0)))
        continue
    w, h = max(1, round((box[2] - box[0]) * s)), max(1, round((box[3] - box[1]) * s))
    px = np.asarray(c)
    # green-screen spill: nothing on a green-keyed character is green, so green never exceeds red or blue
    if green: px = np.dstack([px[..., 0], np.minimum(px[..., 1], np.maximum(px[..., 0], px[..., 2])), px[..., 2]])
    rgba = np.dstack([px, (fg * 255).astype(np.uint8)])
    f = Image.fromarray(rgba, 'RGBA').crop(box)
    rgb = f.convert('RGB').resize((w, h), Image.BOX)
    a = f.getchannel('A').resize((w, h), Image.BOX).point(lambda v: 255 if v >= 128 else 0)
    # strand-thin hair breaks up into specks and pinholes at this size: a 3 x 3 majority smooths the outline
    a = a.filter(ImageFilter.MedianFilter(3))
    # centred, standing on the bottom of the cell
    at = ((out_w - w) // 2, out_h - h)
    full_rgb, full_a = Image.new('RGB', (out_w, out_h)), Image.new('L', (out_w, out_h), 0)
    full_rgb.paste(rgb, at); full_a.paste(a, at)
    frames.append((full_rgb, full_a))
# one palette for the whole sheet keeps colours steady between frames (64: a 166 x 226 frame has room for
# small accents such as gold trim and two-coloured eyes, which 40 colours merged away)
strip = Image.new('RGB', (out_w * len(frames), out_h))
for k, (rgb, _) in enumerate(frames): strip.paste(rgb, (k * out_w, 0))
pal = strip.quantize(colors=64, method=Image.Quantize.FASTOCTREE if octree else Image.MEDIANCUT, dither=Image.Dither.NONE)
sheet = Image.new('RGBA', (out_w * cols, out_h * rows), (0, 0, 0, 0))
for k, (rgb, a) in enumerate(frames):
    q = rgb.quantize(palette=pal, dither=Image.Dither.NONE).convert('RGBA')
    q.putalpha(a)
    sheet.paste(q, ((k % cols) * out_w, (k // cols) * out_h))
sheet.save(dst, optimize=True)
print(dst, 'cell', out_w, out_h, 'sheet', sheet.size, 'figure', round(med_h * s), 'capped' if round(med_h * s) < fig_h else '')
