# Slice a 2x2 sticker sheet into 4 stickers: crop each quarter to its content (non-white), pad, resize, save webp.
import sys, json
from PIL import Image, ImageChops
src, outdir, names = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
im = Image.open(src).convert('RGB')
W, H = im.size
for i, name in enumerate(names):
    x0, y0 = (i % 2) * W // 2, (i // 2) * H // 2
    q = im.crop((x0, y0, x0 + W // 2, y0 + H // 2))
    bg = Image.new('RGB', q.size, (255, 255, 255))
    diff = ImageChops.difference(q, bg).convert('L').point(lambda v: 255 if v > 18 else 0)
    box = diff.getbbox() or (0, 0) + q.size
    pad = 10
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(q.size[0], box[2] + pad), min(q.size[1], box[3] + pad))
    c = q.crop(box)
    s = 260 / max(c.size)
    c = c.resize((round(c.size[0] * s), round(c.size[1] * s)), Image.LANCZOS)
    c.save(f"{outdir}/{name}.webp", 'WEBP', quality=86, method=6)
    print(name, c.size)
