# Build a model-chan sprite pack (schema 2) from its two fitted sheets (fit_cells.py output, 83 x 113
# cells, 4 x 4 each): the base sheet (8 states) on top of the extra sheet (8 more), one 332 x 904 image,
# with every action named after a state of the shared effects layer (src/core/fx.js STATES).
# usage: build_model_chan_pack.py <base.png> <extra.png> <character id> <pack dir>
import json, os, sys
from PIL import Image

base, extra, cid, dst = sys.argv[1:5]
here = os.path.dirname(os.path.abspath(__file__))
c = json.load(open(os.path.join(here, '..', '..', 'src', 'characters', f'{cid}.json')))
# order of the cells in the generated sheets (model_chan_prompts.py), two frames each
BASE = ['idle', 'pat', 'lifted', 'eat_rice', 'sleep', 'think', 'talk', 'happy']
EXTRA = ['look', 'sad', 'hungry', 'eat_cookie', 'eat_fruit', 'play', 'hatch', 'evolve']
FPS = {'idle': 2, 'pat': 4, 'lifted': 6, 'eat_rice': 3, 'sleep': 1.5, 'think': 2, 'talk': 5, 'happy': 5,
       'look': 1.5, 'sad': 2, 'hungry': 2, 'eat_cookie': 3, 'eat_fruit': 3, 'play': 4, 'hatch': 2, 'evolve': 4}
actions = {a: {'row': i // 2 + off, 'col': (i % 2) * 2, 'frames': 2, 'fps': FPS[a]} for off, names in ((0, BASE), (4, EXTRA)) for i, a in enumerate(names)}

top, bottom = Image.open(base).convert('RGBA'), Image.open(extra).convert('RGBA')
sheet = Image.new('RGBA', (top.width, top.height + bottom.height), (0, 0, 0, 0))
sheet.paste(top, (0, 0))
sheet.paste(bottom, (0, top.height))
os.makedirs(os.path.join(dst, 'sheets'), exist_ok=True)
sheet.save(os.path.join(dst, 'sheets', 'daily.png'), optimize=True)
manifest = {
    'schema': 2, 'id': f'{cid}-pixel', 'name': f"{c['nameZh']} · 像素", 'version': '2.0.0',
    'author': 'rdmclin2（gpt-image-2.5 生成，脚本像素化）；原设 ZipZipPipe，设定 lmy414', 'license': 'CC BY-NC-SA 4.0',
    'description': f"{c['title']}（同人，非 {c['vendor']} 官方）。16 位像素风，16 个动作（含大肥鱼全部 15 个状态和拎起）。",
    'species': cid, 'kind': 'sprites', 'pixelated': True, 'frame': {'width': 83, 'height': 113},
    'actions': actions, 'outfits': {'daily': 'sheets/daily.png'},
}
with open(os.path.join(dst, 'pack.json'), 'w') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2); f.write('\n')
print(dst, 'ok')
