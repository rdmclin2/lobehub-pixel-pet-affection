# Give a model-chan sprite pack a `walk` action, so walking is more than the window sliding the standing pose
# along. She walks left and right across the screen, so the HD packs take a side-view walk cycle drawn for it
# (--from, below); without one, a 4-frame step cycle in place is made from the idle art (the classic packs).
#
# --from <fit sheet> [--take N]: a model_chan_prompts.py --walk sheet put through slice_sheet.py --shared-box and
# fit_cells.py --rows 2 (4 frames per row, facing right; take N = row N, default 0). Each frame stands on the
# cell's bottom with her head and body (the top 40 % of the figure) centred, so the body glides and only the legs,
# hair and skirt move; facing left mirrors it.
#
# Without --from: The legs under the hem are found in the first
# idle frame (the transparent gap between them), and each frame lifts one leg (squashed up under the skirt,
# so the foot leaves the ground) or brings both down with the whole figure a little higher:
#   left foot up · both down (up a bit) · right foot up · both down (up a bit)
# The frames go in a new row under the sheet (every outfit sheet of the pack) and pack.json gets
# "walk": {row, col 0, frames 4, fps 8}. Running it again rebuilds that row.
# --outfit <id>: only that outfit's sheet. A side-view walk sheet is drawn for one outfit, so --from goes into
# the daily sheet unless --outfit names another one; every outfit sheet keeps its own walk row.
# usage: add_walk_frames.py [--outfit <id>] <pack dir> [<pack dir> ...]
#        add_walk_frames.py --from <fit sheet> [--take N] [--outfit <id>] <pack dir>
import json, os, sys
import numpy as np
from PIL import Image

FPS = 8
SIDE_FPS = 5  # one step (2 frames, 0.4 s) is about 44 px on screen at 100 %, the window's pace (fx.js WALK.speed 110), so the feet do not skate


def find_legs(a):
    # a: alpha (H x W, bool) of the idle frame -> (hem row, bottom row, gap column per row from hem to bottom)
    H, W = a.shape
    rows = np.where(a.any(axis=1))[0]
    bottom = int(rows[-1])
    top = int(rows[0])
    band = a[max(top, bottom - (bottom - top) // 6):bottom + 1]
    cx = int(round(np.where(band)[1].mean()))
    reach = max(3, W // 14)

    def gap_at(y, near):
        # the transparent column nearest `near` with the figure on both sides of it in row y
        xs = np.where(a[y])[0]
        if len(xs) < 2: return None
        for d in range(reach + 1):
            for x in (near - d, near + d):
                if xs[0] < x < xs[-1] and not a[y, x]: return x
        return None

    # start a little above the soles (shoes may touch) and follow the gap up to where the skirt closes it
    start = bottom - max(2, (bottom - top) // 40)
    x0 = None
    for y in range(start, start - max(4, (bottom - top) // 10), -1):
        x0 = gap_at(y, cx)
        if x0 is not None:
            start = y
            break
    if x0 is None: raise SystemExit('no gap between the legs found')
    gaps = {}
    x, y = x0, start
    while y > top:
        g = gap_at(y, x)
        if g is None or abs(g - x) > 2: break
        gaps[y] = x = g
        y -= 1
    hem = y + 1
    for yy in range(start + 1, bottom + 1): gaps[yy] = x0
    return hem, bottom, gaps, reach * 3


def walk_frames(frame, smooth):
    rgba = np.array(frame)
    a = rgba[:, :, 3] > 40
    H, W = a.shape
    hem, bottom, gaps, half = find_legs(a)
    L = bottom - hem + 1
    lift = max(2, round(L * 0.2))
    bob = max(1, round(H * 0.006))
    left = np.zeros_like(rgba); right = np.zeros_like(rgba)
    body = rgba.copy()
    for y in range(hem, bottom + 1):
        g = gaps[y]
        lo, hi = max(0, g - half), min(W, g + half + 1)
        left[y, lo:g] = rgba[y, lo:g]; right[y, g:hi] = rgba[y, g:hi]
        body[y, lo:hi] = 0
    resample = Image.LANCZOS if smooth else Image.NEAREST

    def leg(img, lifted):
        im = Image.fromarray(img)
        if not lifted: return im
        strip = im.crop((0, hem, W, bottom + 1)).resize((W, L - lift), resample)
        out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        out.paste(strip, (0, hem))
        return out

    def compose(lift_left, lift_right, dy):
        out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        for layer in (leg(left, lift_left), leg(right, lift_right), Image.fromarray(body)):
            out.alpha_composite(layer, (0, -dy) if dy else (0, 0))
        return out

    return [compose(True, False, 0), compose(False, False, bob), compose(False, True, 0), compose(False, False, bob)], (hem, bottom, lift)


def side_frames(path, take, FW, FH):
    sheet = Image.open(path).convert('RGBA')
    cw, ch = sheet.width // 4, sheet.height // 2
    out = []
    for c in range(4):
        f = np.array(sheet.crop((c * cw, take * ch, (c + 1) * cw, (take + 1) * ch)))
        a = f[:, :, 3] > 40
        ys = np.where(a.any(axis=1))[0]
        top, bottom = int(ys[0]), int(ys[-1])
        upper = a[top:top + int((bottom - top) * 0.4)]
        cx = np.where(upper)[1].mean()
        frame = Image.new('RGBA', (FW, FH), (0, 0, 0, 0))
        frame.paste(Image.fromarray(f), (int(round(FW / 2 - cx)), FH - 1 - bottom))
        out.append(frame)
    return out


def add_walk(pack_dir, side=None, take=0, outfit=None):
    pf = os.path.join(pack_dir, 'pack.json')
    pack = json.load(open(pf))
    FW, FH = pack['frame']['width'], pack['frame']['height']
    idle = pack['actions']['idle']
    old = pack['actions'].get('walk')
    if side and not outfit: outfit = 'daily'
    if outfit and outfit not in pack['outfits']: raise SystemExit(f'{pack_dir}: no {outfit} sheet in pack.json')
    sheets = [pack['outfits'][outfit]] if outfit else sorted(set(pack['outfits'].values()))
    for rel in sheets:
        path = os.path.join(pack_dir, rel)
        sheet = Image.open(path).convert('RGBA')
        rows = old['row'] if old else sheet.height // FH
        frame = sheet.crop((idle['col'] * FW, idle['row'] * FH, (idle['col'] + 1) * FW, (idle['row'] + 1) * FH))
        if side:
            frames, info = side_frames(side, take, FW, FH), ('side view', os.path.basename(side), f'take {take}')
        else:
            frames, info = walk_frames(frame, not pack.get('pixelated'))
        out = Image.new('RGBA', (max(sheet.width, FW * 4), FH * (rows + 1)), (0, 0, 0, 0))
        out.paste(sheet.crop((0, 0, sheet.width, FH * rows)), (0, 0))
        for i, f in enumerate(frames): out.paste(f, (i * FW, rows * FH))
        if path.endswith('.webp'): out.save(path, 'WEBP', quality=92, method=6, alpha_quality=100)
        else: out.save(path, optimize=True)
        print(f'{path}: walk row {rows}, ' + (' '.join(info) if side else f'legs rows {info[0]}-{info[1]}, lift {info[2]} px'))
    pack['actions']['walk'] = {'row': rows, 'col': 0, 'frames': 4, 'fps': SIDE_FPS if side else FPS}
    with open(pf, 'w') as f:
        json.dump(pack, f, ensure_ascii=False, indent=2); f.write('\n')


if __name__ == '__main__':
    argv = sys.argv[1:]
    side, take, outfit = None, 0, None
    if '--outfit' in argv:
        i = argv.index('--outfit'); outfit = argv[i + 1]; del argv[i:i + 2]
    if '--from' in argv:
        i = argv.index('--from'); side = argv[i + 1]; del argv[i:i + 2]
    if '--take' in argv:
        i = argv.index('--take'); take = int(argv[i + 1]); del argv[i:i + 2]
    if not argv: raise SystemExit('usage: add_walk_frames.py <pack dir> [...] | add_walk_frames.py --from <fit sheet> [--take N] <pack dir>')
    for d in argv: add_walk(d, side, take, outfit)
