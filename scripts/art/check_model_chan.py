# Check the model-chan pixel packs (src/renderer/packs/*-pixel, schema 2) and print one line per action.
# Passes when every outfit sheet of every pack is an RGBA PNG or WebP of 4 x 9 cells of 332 x 452 (the HD packs), every state of the shared effects
# layer (17, `walk` from add_walk_frames.py in the 9th row) has an action, and every frame of every action has a visible figure.
# Also, per character (src/characters/<id>.json): every outfit it offers has a sheet in its default pack (art.packs[0]);
# per outfit sheet: no magenta key left on the figure and nothing touching a cell's edge (a clean transparent background);
# and every other outfit lines up with daily frame by frame (same floor, about the same height and centre), so
# changing clothes does not make her jump.
# usage: check_model_chan.py [repo root]
import json, os, sys
import numpy as np
from PIL import Image

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
STATES = ['idle', 'look', 'happy', 'pat', 'sad', 'hungry', 'sleep', 'eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'talk', 'play', 'hatch', 'evolve', 'lifted', 'walk']
FW, FH = 332, 452
MIN_PX = 6400      # opaque pixels a frame needs to count as drawn
MAGENTA_MAX = 50   # pure magenta pixels (the key colour) allowed on a whole sheet
FLOOR_DY, HEIGHT_RATIO, CENTRE_DX = 6, 0.12, 48  # largest per-frame differences from daily
packs_dir = os.path.join(root, 'src/renderer/packs')
bad = 0

def fail(msg):
    global bad
    bad += 1
    print(f'  {msg}')

def frames(pack):
    for name in STATES:
        v = pack['actions'].get(name)
        if v:
            for k in range(v['frames']): yield name, k, (v['col'] + k) * FW, v['row'] * FH

def box(a, x, y):
    # (bottom, height, centre x) of the solid figure in one cell
    c = a[y:y + FH, x:x + FW] >= 128
    ys, xs = np.nonzero(c)
    if not len(ys): return None
    return int(ys.max()), int(ys.max() - ys.min() + 1), float(xs.mean())

for pid in sorted(p for p in os.listdir(packs_dir) if p.endswith('-pixel')):
    d = os.path.join(packs_dir, pid)
    pack = json.load(open(os.path.join(d, 'pack.json')))
    daily_boxes = None
    for outfit in ['daily'] + sorted(o for o in pack['outfits'] if o != 'daily'):
        im = Image.open(os.path.join(d, pack['outfits'][outfit]))
        ok = pack['schema'] == 2 and im.format in ('PNG', 'WEBP') and im.mode == 'RGBA' and im.size == (FW * 4, FH * 9) and (pack['frame']['width'], pack['frame']['height']) == (FW, FH)
        bad += not ok
        print(f"{pid} [{outfit}] {pack['outfits'][outfit]}: schema {pack['schema']} {im.format} {im.mode} {im.size} {'OK' if ok else 'MISMATCH'}")
        px = np.asarray(im.convert('RGBA')).astype(np.int32)
        a = px[..., 3]
        for name in STATES:
            v = pack['actions'].get(name)
            if not v:
                fail(f"{name:<11} MISSING")
                continue
            counts = []
            for k in range(v['frames']):
                x, y = (v['col'] + k) * FW, v['row'] * FH
                counts.append(int((a[y:y + FH, x:x + FW] > 0).sum()))
            good = all(c >= MIN_PX for c in counts)
            bad += not good
            print(f"  {name:<11} row {v['row']} col {v['col']} x{v['frames']} @{v['fps']}fps  opaque px {counts} {'OK' if good else 'EMPTY'}")
        # the key colour left on the figure: bright magenta (red and blue high, green low)
        r, g, b = px[..., 0], px[..., 1], px[..., 2]
        magenta = int(((a > 0) & (r > 200) & (b > 200) & (g < 60) & (abs(r - b) < 50)).sum())
        # a clean background: nothing on the top, left or right edge of any cell (a figure cut off, or stray
        # bits of a neighbouring cell); she stands on the bottom edge
        edges = sum(int((a[y, x:x + FW] > 0).sum() + (a[y:y + FH, x] > 0).sum() + (a[y:y + FH, x + FW - 1] > 0).sum()) for _, _, x, y in frames(pack))
        clean = magenta <= MAGENTA_MAX and edges == 0
        bad += not clean
        print(f"  background  magenta px {magenta} (≤ {MAGENTA_MAX}), opaque px on cell edges {edges} {'OK' if clean else 'DIRTY'}")
        boxes = {(n, k): box(a, x, y) for n, k, x, y in frames(pack)}
        if outfit == 'daily':
            daily_boxes = boxes
            continue
        worst = {'floor': 0, 'height': 0.0, 'centre': 0.0}
        off = []
        for key, b in boxes.items():
            base = daily_boxes.get(key)
            if not b or not base: continue
            dy, dh, dx = abs(b[0] - base[0]), abs(b[1] / base[1] - 1), abs(b[2] - base[2])
            worst = {'floor': max(worst['floor'], dy), 'height': max(worst['height'], dh), 'centre': max(worst['centre'], dx)}
            if dy > FLOOR_DY or dh > HEIGHT_RATIO or dx > CENTRE_DX: off.append(f"{key[0]}#{key[1]} floor Δ{dy} height Δ{dh:.0%} centre Δ{dx:.0f}")
        aligned = not off
        bad += not aligned
        print(f"  vs daily    worst floor Δ{worst['floor']} px (≤ {FLOOR_DY}), height Δ{worst['height']:.1%} (≤ {HEIGHT_RATIO:.0%}), centre Δ{worst['centre']:.0f} px (≤ {CENTRE_DX}) {'OK' if aligned else 'JUMPS: ' + '; '.join(off)}")

# every outfit a character offers has art in her default pack
chars_dir = os.path.join(root, 'src/characters')
for f in sorted(os.listdir(chars_dir)):
    if not f.endswith('.json'): continue
    c = json.load(open(os.path.join(chars_dir, f)))
    packs = (c.get('art') or {}).get('packs') or []
    if not packs: continue
    pack = json.load(open(os.path.join(packs_dir, packs[0], 'pack.json')))
    missing = [o for o in c['outfits'] if o not in pack['outfits'] or not os.path.exists(os.path.join(packs_dir, packs[0], pack['outfits'][o]))]
    bad += bool(missing)
    print(f"{c['id']}: outfits {c['outfits']} in {packs[0]} {'OK' if not missing else 'MISSING ' + ', '.join(missing)}")
print('RESULT', 'PASS' if not bad else f'FAIL ({bad})')
sys.exit(1 if bad else 0)
