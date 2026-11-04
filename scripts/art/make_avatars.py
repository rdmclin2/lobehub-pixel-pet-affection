# Head-and-shoulders avatars for the built-in characters (T-2839): the chat list and the chat bubbles show a face,
# not her whole body. Each one is cut from the first idle frame of her default pack's daily sheet
# (src/characters/<id>.json art.packs[0]), on a soft tint of her accent colour, and written next to the sheet as
# src/renderer/packs/<pack>/avatar.webp (the character file's `avatar` points at it).
# usage: make_avatars.py [repo root] [--char <id>]
import json, os, sys
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:]]
only = None
if '--char' in args:
    i = args.index('--char')
    only = args[i + 1]
    del args[i:i + 2]
root = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')

FW, FH = 664, 904  # one cell of a schema 2 HD sheet
BOX = 220          # crop side in sheet pixels: her head, hair ornaments and a little of her shoulders
OUT = 256          # avatar side
TINT = 0.18        # how much of her accent goes into the background (the rest is white)

for f in sorted(os.listdir(os.path.join(root, 'src/characters'))):
    c = json.load(open(os.path.join(root, 'src/characters', f), encoding='utf8'))
    if only and c['id'] != only:
        continue
    pack = c['art']['packs'][0]
    pack_dir = os.path.join(root, 'src/renderer/packs', pack)
    meta = json.load(open(os.path.join(pack_dir, 'pack.json'), encoding='utf8'))
    idle = meta['actions']['idle']
    sheet = Image.open(os.path.join(pack_dir, meta['outfits']['daily'])).convert('RGBA')
    x, y = idle['col'] * FW, idle['row'] * FH
    frame = sheet.crop((x, y, x + FW, y + FH))
    a = np.array(frame)[:, :, 3] > 20
    ys = np.where(a.any(1))[0]
    top = int(ys.min())
    # centre on her face: the middle of what is drawn in the band below the top of her head
    band = a[top + 40:top + 170]
    cx = int(round((np.arange(FW) * band.sum(0)).sum() / band.sum()))
    box = (cx - BOX // 2, top - 8, cx + BOX // 2, top - 8 + BOX)
    h = c['accent'].lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    bg = Image.new('RGBA', (BOX, BOX), tuple(int(255 * (1 - TINT) + v * TINT) for v in (r, g, b)) + (255,))
    bg.alpha_composite(frame.crop(box))
    out = os.path.join(pack_dir, 'avatar.webp')
    bg.convert('RGB').resize((OUT, OUT), Image.LANCZOS).save(out, 'WEBP', quality=90, method=6)
    print(f"{c['id']}: {os.path.relpath(out, root)} (box {box})")
