# Check the model-chan packs against bubbo-pixel's format and print one line per action frame.
# Passes when every sheet is an RGBA PNG of the reference size, every frame of every action (pack.json +
# actions-extra.json) has a visible figure, and every DeepSeek clip maps to a sprite action.
# usage: check_model_chan.py [repo root]
import json, os, sys
from PIL import Image

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
ref = json.load(open(os.path.join(root, 'src/renderer/packs/bubbo-pixel/pack.json')))
ref_im = Image.open(os.path.join(root, 'src/renderer/packs/bubbo-pixel/sheets/daily.png'))
fw, fh = ref['frame']['width'], ref['frame']['height']
print(f"reference bubbo-pixel: {ref_im.format} {ref_im.mode} {ref_im.size}, frame {fw}x{fh}")
clips = json.load(open(os.path.join(root, 'art/model-chan/characters.json')))['characters'][0]['art']['states']
bad = 0
packs_dir = os.path.join(root, 'art/model-chan/packs')
for pid in sorted(os.listdir(packs_dir)):
    d = os.path.join(packs_dir, pid)
    pack = json.load(open(os.path.join(d, 'pack.json')))
    extra = json.load(open(os.path.join(d, 'actions-extra.json')))
    groups = [(pack['outfits']['daily'], pack['actions']), (extra['sheet'], extra['actions'])]
    for rel, actions in groups:
        im = Image.open(os.path.join(d, rel))
        ok = im.format == ref_im.format and im.mode == ref_im.mode and im.size == ref_im.size and (pack['frame']['width'], pack['frame']['height']) == (fw, fh)
        bad += not ok
        print(f"{pid}/{rel}: {im.format} {im.mode} {im.size} {'OK' if ok else 'MISMATCH'}")
        a = im.getchannel('A')
        for name, v in actions.items():
            counts = []
            for k in range(v['frames']):
                x, y = (v['col'] + k) * fw, v['row'] * fh
                counts.append(sum(1 for p in a.crop((x, y, x + fw, y + fh)).getdata() if p))
            good = all(c >= 400 for c in counts)
            bad += not good
            print(f"  {name:<11} row {v['row']} col {v['col']} x{v['frames']} @{v['fps']}fps  opaque px {counts} {'OK' if good else 'EMPTY'}")
    known = set(pack['actions']) | set(extra['actions'])
    missing = [c for c in clips if extra['clips'].get(c) not in known]
    bad += bool(missing)
    print(f"  DeepSeek states covered: {len(clips) - len(missing)}/{len(clips)}" + (f" missing {missing}" if missing else ''))
print('RESULT', 'PASS' if not bad else f'FAIL ({bad})')
sys.exit(1 if bad else 0)
