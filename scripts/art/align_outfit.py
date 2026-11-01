# Align an outfit sheet to the pack's daily sheet: gpt-image sometimes draws a few cells of a grid a size
# bigger or smaller (often the crouching hatch frame), which check_model_chan.py reports as a height jump.
# Every frame whose figure height differs from the same daily frame by more than --tol (default 11.5%, just inside check_model_chan.py's 12%) is
# scaled about its feet to the daily height, staying inside its cell. Writes the sheet in place.
# usage: align_outfit.py <pack dir> <outfit> [--tol 0.115] [--keep hatch#0]
import json, os, sys
import numpy as np
from PIL import Image

d, outfit = sys.argv[1], sys.argv[2]
tol = float(sys.argv[sys.argv.index('--tol') + 1]) if '--tol' in sys.argv else 0.115
# --keep <action#frame,...>: frames left at their own height (a stand-in for a pose not drawn, e.g. hatch#0)
keep = set(sys.argv[sys.argv.index('--keep') + 1].split(',')) if '--keep' in sys.argv else set()
pack = json.load(open(os.path.join(d, 'pack.json')))
FW, FH = pack['frame']['width'], pack['frame']['height']
daily = np.asarray(Image.open(os.path.join(d, pack['outfits']['daily'])).convert('RGBA'))[..., 3]
path = os.path.join(d, pack['outfits'][outfit])
sheet = Image.open(path).convert('RGBA')

def bbox(a):
    ys, xs = np.nonzero(a >= 128)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(ys) else None

fixed = []
for name, v in pack['actions'].items():
    for k in range(v['frames']):
        x, y = (v['col'] + k) * FW, v['row'] * FH
        cell = sheet.crop((x, y, x + FW, y + FH))
        b, bd = bbox(np.asarray(cell)[..., 3]), bbox(daily[y:y + FH, x:x + FW])
        if not b or not bd: continue
        h, hd = b[3] - b[1], bd[3] - bd[1]
        if abs(h / hd - 1) <= tol or f'{name}#{k}' in keep: continue
        full = cell.getbbox()  # include the soft edge, not only the solid part
        fig = cell.crop(full)
        s = hd / h
        s = min(s, (full[3] - 1) / fig.height, (FW - 2) / fig.width)  # stay inside the cell
        fig = fig.resize((max(1, round(fig.width * s)), max(1, round(fig.height * s))), Image.LANCZOS)
        cx = (full[0] + full[2]) // 2
        left = max(1, min(FW - 1 - fig.width, cx - fig.width // 2))
        out = Image.new('RGBA', (FW, FH))
        out.paste(fig, (left, full[3] - fig.height), fig)
        sheet.paste(out, (x, y))
        fixed.append(f'{name}#{k} {h}->{round(h * s)} (daily {hd})')

if fixed:
    if path.endswith('.webp'): sheet.save(path, 'WEBP', quality=92, method=6, alpha_quality=100)
    else: sheet.save(path, optimize=True)
print(f"{os.path.basename(d)} [{outfit}] aligned {len(fixed)}: {'; '.join(fixed) if fixed else 'nothing to do'}")
