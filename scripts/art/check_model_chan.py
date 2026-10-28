# Check the model-chan pixel packs (src/renderer/packs/*-pixel, schema 2) and print one line per action.
# Passes when every sheet is an RGBA PNG of 4 x 8 cells of 83 x 113, every state of the shared effects
# layer (16) has an action, and every frame of every action has a visible figure.
# usage: check_model_chan.py [repo root]
import json, os, sys
from PIL import Image

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
STATES = ['idle', 'look', 'happy', 'pat', 'sad', 'hungry', 'sleep', 'eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'talk', 'play', 'hatch', 'evolve', 'lifted']
FW, FH = 83, 113
packs_dir = os.path.join(root, 'src/renderer/packs')
bad = 0
for pid in sorted(p for p in os.listdir(packs_dir) if p.endswith('-pixel')):
    d = os.path.join(packs_dir, pid)
    pack = json.load(open(os.path.join(d, 'pack.json')))
    im = Image.open(os.path.join(d, pack['outfits']['daily']))
    ok = pack['schema'] == 2 and im.format == 'PNG' and im.mode == 'RGBA' and im.size == (FW * 4, FH * 8) and (pack['frame']['width'], pack['frame']['height']) == (FW, FH)
    bad += not ok
    print(f"{pid}: schema {pack['schema']} {im.format} {im.mode} {im.size} {'OK' if ok else 'MISMATCH'}")
    a = im.getchannel('A')
    for name in STATES:
        v = pack['actions'].get(name)
        if not v:
            bad += 1
            print(f"  {name:<11} MISSING")
            continue
        counts = []
        for k in range(v['frames']):
            x, y = (v['col'] + k) * FW, v['row'] * FH
            counts.append(sum(1 for p in a.crop((x, y, x + FW, y + FH)).getdata() if p))
        good = all(c >= 400 for c in counts)
        bad += not good
        print(f"  {name:<11} row {v['row']} col {v['col']} x{v['frames']} @{v['fps']}fps  opaque px {counts} {'OK' if good else 'EMPTY'}")
print('RESULT', 'PASS' if not bad else f'FAIL ({bad})')
sys.exit(1 if bad else 0)
