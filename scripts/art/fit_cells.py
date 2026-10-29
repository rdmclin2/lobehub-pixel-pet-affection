# Fit a sliced 4 x 4 (or 4 x 2, --rows 2) sheet (slice_sheet.py output) into fixed cells, so every sheet of
# every character uses the frame size of the built-in pixel packs (166 x 226): figure centred, standing on the cell's bottom, scaled down
# (nearest neighbour, keeps hard pixels) only when a frame is larger than the cell.
# usage: fit_cells.py <sliced.png> <out.png> [cell_w cell_h] [--keep-violet] [--rows N] [--key green]
#   --key green: the sheet was keyed on green (slice_sheet.py --key green): clean a green rim instead
#   --keep-violet: for a violet-haired character (Gemini), only drop pixels that are mostly key colour and skip
#   the pull to neutral; that pull cannot tell lavender hair from a pink rim and turns her hair grey.
import sys
import numpy as np
from PIL import Image

keep_violet = '--keep-violet' in sys.argv
argv = [x for x in sys.argv if x != '--keep-violet']
green = False
if '--key' in argv:
    i = argv.index('--key')
    green = argv[i + 1] == 'green'
    del argv[i:i + 2]
ROWS = 4
if '--rows' in argv:
    i = argv.index('--rows')
    ROWS = int(argv[i + 1])
    del argv[i:i + 2]
src, dst = argv[1], argv[2]
CW, CH = (int(argv[3]), int(argv[4])) if len(argv) > 4 else (166, 226)
COLS = 4
im = Image.open(src).convert('RGBA')
w, h = im.width // COLS, im.height // ROWS
s = min(1, CW / w, CH / h)
out = Image.new('RGBA', (CW * COLS, CH * ROWS), (0, 0, 0, 0))
for k in range(COLS * ROWS):
    cell = im.crop(((k % COLS) * w, (k // COLS) * h, (k % COLS + 1) * w, (k // COLS + 1) * h))
    if s < 1: cell = cell.resize((max(1, round(w * s)), max(1, round(h * s))), Image.NEAREST)
    out.paste(cell, ((k % COLS) * CW + (CW - cell.width) // 2, (k // COLS) * CH + (CH - cell.height)))
# The magenta key leaves a pink rim on hair edges and in enclosed gaps (between curls): drop pixels that are
# mostly key colour, and pull tinted ones back to neutral (min(r, b) - g removed from r and b): near
# transparency even when faint, elsewhere only when strong, so the characters' own reds stay.
a = np.asarray(out).astype(np.int32)
solid = a[..., 3] > 0
near = np.zeros_like(solid)
for dy in range(-2, 3):
    for dx in range(-2, 3):
        near |= ~np.roll(np.roll(solid, dy, 0), dx, 1)
edge = solid & near
if green:
    spill = a[..., 1] - np.maximum(a[..., 0], a[..., 2])
    a[spill > 70, 3] = 0
    fix = (edge & (spill > 12)) | (spill > 40)
    a[fix, 1] -= spill[fix]
else:
    spill = np.minimum(a[..., 0], a[..., 2]) - a[..., 1]
    a[spill > 70, 3] = 0
    if not keep_violet:
        fix = (edge & (spill > 12)) | (spill > 40)
        a[fix, 0] -= spill[fix]
        a[fix, 2] -= spill[fix]
out = Image.fromarray(a.clip(0, 255).astype(np.uint8), 'RGBA')
out.save(dst, optimize=True)
print(dst, 'cell', CW, CH, 'sheet', out.size, 'scale', round(s, 3))
