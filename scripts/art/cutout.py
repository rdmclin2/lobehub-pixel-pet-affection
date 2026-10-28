# usage: cutout.py <in.png> <out.png> [height]
# Remove a flat magenta background: flood fill from the border over pixels close to the key colour,
# despill magenta at the edge, crop to the figure and scale to a fixed height.
import sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
H = int(sys.argv[3]) if len(sys.argv) > 3 else 512
im = np.asarray(Image.open(src).convert('RGB')).astype(np.int32)
h, w, _ = im.shape
r, g, b = im[..., 0], im[..., 1], im[..., 2]
# "magenta-ness": strong red and blue, weak green
key = (np.minimum(r, b) - g)
bgish = key > 70
seen = np.zeros((h, w), bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if bgish[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if bgish[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and bgish[ny, nx]:
            seen[ny, nx] = True; q.append((ny, nx))
# Enclosed holes (between an arm and the body) that are pure key colour are background too.
hole = key > 150
mask = ~(seen | hole)
alpha = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
a = np.asarray(alpha).astype(np.int32)
# Despill: pull magenta out of semi-transparent / edge pixels.
spill = np.clip(np.minimum(r, b) - g, 0, None)
edge = (a < 255) | (np.asarray(Image.fromarray((seen * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 0)
rr = np.where(edge, r - spill * 0.6, r); bb = np.where(edge, b - spill * 0.6, b)
out = np.dstack([np.clip(rr, 0, 255), g, np.clip(bb, 0, 255), a]).astype(np.uint8)
img = Image.fromarray(out, 'RGBA')
bbox = img.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
img = img.crop(bbox)
pad = int(img.height * 0.02)
canvas = Image.new('RGBA', (img.width + 2 * pad, img.height + 2 * pad), (0, 0, 0, 0))
canvas.paste(img, (pad, pad))
s = H / canvas.height
canvas = canvas.resize((max(1, round(canvas.width * s)), H), Image.LANCZOS)
canvas.save(dst, optimize=True)
print(dst, canvas.size)
