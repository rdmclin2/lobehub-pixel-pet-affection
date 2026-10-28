# Build a sprite pet pack from sliced sheets (slice_sheet.py output, 4 x 4 cells in ACTIONS order, two
# frames per action): pad every sheet to one cell size (figure centred, standing on the cell's bottom)
# and write pack.json. Usage: build_pixel_pack.py <sliced dir> <species> <pack dir>
import json, os, sys
from PIL import Image

src, species, dst = sys.argv[1], sys.argv[2], sys.argv[3]
CHARS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'characters')
NAMES = {f[:-5]: json.load(open(os.path.join(CHARS, f)))['nameZh'] for f in os.listdir(CHARS) if f.endswith('.json')}
ACTIONS = ['idle', 'wave', 'lifted', 'eat', 'sleep', 'think', 'talk', 'cheer']
FPS = {'idle': 2, 'wave': 4, 'lifted': 6, 'eat': 3, 'sleep': 1.5, 'think': 2, 'talk': 5, 'cheer': 5}
COLS, ROWS = 4, 4

files = sorted(f for f in os.listdir(src) if f.startswith(species + '_') and f.endswith('.png'))
sheets = {f[len(species) + 1:-4]: Image.open(os.path.join(src, f)).convert('RGBA') for f in files}
cw = max(im.width // COLS for im in sheets.values())
ch = max(im.height // ROWS for im in sheets.values())
os.makedirs(os.path.join(dst, 'sheets'), exist_ok=True)
outfits = {}
for outfit, im in sheets.items():
    w, h = im.width // COLS, im.height // ROWS
    out = Image.new('RGBA', (cw * COLS, ch * ROWS), (0, 0, 0, 0))
    for k in range(COLS * ROWS):
        cell = im.crop(((k % COLS) * w, (k // COLS) * h, (k % COLS + 1) * w, (k // COLS + 1) * h))
        out.paste(cell, ((k % COLS) * cw + (cw - w) // 2, (k // COLS) * ch + (ch - h)))
    rel = f'sheets/{outfit}.png'
    out.save(os.path.join(dst, rel), optimize=True)
    outfits[outfit] = rel
actions = {a: {'row': i // 2, 'col': (i % 2) * 2, 'frames': 2, 'fps': FPS[a]} for i, a in enumerate(ACTIONS)}
manifest = {
    'schema': 1, 'id': f'{species}-pixel', 'name': f'{NAMES[species]} · 像素', 'version': '1.0.0',
    'author': 'rdmclin2（gpt-image-2.5 生成，脚本像素化）', 'license': 'CC BY-NC-SA 4.0' if species == 'dafeiyu' else 'MIT',
    'description': '16 位像素风，每套服饰 8 个动作：待机、挥手、被拎起来、吃饭、打瞌睡、思考、说话、欢呼。',
    'species': species, 'kind': 'sprites', 'pixelated': True, 'frame': {'width': cw, 'height': ch},
    'actions': actions, 'outfits': outfits,
}
with open(os.path.join(dst, 'pack.json'), 'w') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2); f.write('\n')
print(dst, 'cell', cw, ch, 'outfits', len(outfits))
