# Build a model-chan sprite pack (schema 2) from its fitted sheets (fit_cells.py output, e.g. 332 x 452 cells,
# 4 columns): the base sheet (8 states) on top of the extra sheet (8 more), one 664 x 1808 image, with every
# action named after a state of the shared effects layer (src/core/fx.js STATES). Each sheet may come as
# two 4 x 2 halves (one per generated image), stacked in order.
# usage: build_model_chan_pack.py <base.png | base_a.png base_b.png> <extra.png | extra_a.png extra_b.png> <character id> <pack dir>
import json, os, sys
from PIL import Image

# --hd: the sheets came from slice_sheet.py --smooth: write a lossy WebP (lossless alpha) and mark the pack
# as not pixelated, so the app draws it smoothed instead of as blocks
hd = '--hd' in sys.argv
*parts, cid, dst = [a for a in sys.argv[1:] if a != '--hd']
here = os.path.dirname(os.path.abspath(__file__))
c = json.load(open(os.path.join(here, '..', '..', 'src', 'characters', f'{cid}.json')))
# order of the cells in the generated sheets (model_chan_prompts.py), two frames each
BASE = ['idle', 'pat', 'lifted', 'eat_rice', 'sleep', 'think', 'talk', 'happy']
EXTRA = ['look', 'sad', 'hungry', 'eat_cookie', 'eat_fruit', 'play', 'hatch', 'evolve']
FPS = {'idle': 2, 'pat': 4, 'lifted': 6, 'eat_rice': 3, 'sleep': 1.5, 'think': 2, 'talk': 5, 'happy': 5,
       'look': 1.5, 'sad': 2, 'hungry': 2, 'eat_cookie': 3, 'eat_fruit': 3, 'play': 4, 'hatch': 2, 'evolve': 4}
actions = {a: {'row': i // 2 + off, 'col': (i % 2) * 2, 'frames': 2, 'fps': FPS[a]} for off, names in ((0, BASE), (4, EXTRA)) for i, a in enumerate(names)}

ims = [Image.open(p).convert('RGBA') for p in parts]
FW = ims[0].width // 4
FH = FW * 226 // 166
assert all(im.width == FW * 4 and im.height % FH == 0 for im in ims) and sum(im.height for im in ims) == FH * 8, 'expected 4 x 8 cells in all'
sheet = Image.new('RGBA', (FW * 4, FH * 8), (0, 0, 0, 0))
y = 0
for im in ims:
    sheet.paste(im, (0, y))
    y += im.height
os.makedirs(os.path.join(dst, 'sheets'), exist_ok=True)
sheet_name = 'daily.webp' if hd else 'daily.png'
for old_sheet in ('daily.png', 'daily.webp'):
    if old_sheet != sheet_name and os.path.exists(os.path.join(dst, 'sheets', old_sheet)): os.remove(os.path.join(dst, 'sheets', old_sheet))
if hd: sheet.save(os.path.join(dst, 'sheets', sheet_name), 'WEBP', quality=92, method=6, alpha_quality=100)
else: sheet.save(os.path.join(dst, 'sheets', sheet_name), optimize=True)
manifest = {
    'schema': 2, 'id': f'{cid}-pixel', 'name': f"{c['nameZh']} · 像素", 'version': '4.0.0' if hd else '3.0.0',
    'author': 'rdmclin2（gpt-image-2.5 生成，脚本像素化）；原设 ZipZipPipe，设定 lmy414', 'license': 'CC BY-NC-SA 4.0',
    'description': f"{c['title']}（同人，非 {c['vendor']} 官方）。16 位像素风，16 个动作（含大肥鱼全部 15 个状态和拎起）。",
    'species': cid, 'kind': 'sprites', 'pixelated': not hd, 'frame': {'width': FW, 'height': FH},
    'actions': actions, 'outfits': {'daily': f'sheets/{sheet_name}'},
}
# a description written by hand in an existing pack.json is kept
old = os.path.join(dst, 'pack.json')
if os.path.exists(old): manifest['description'] = json.load(open(old)).get('description') or manifest['description']
with open(os.path.join(dst, 'pack.json'), 'w') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2); f.write('\n')
print(dst, 'ok')
