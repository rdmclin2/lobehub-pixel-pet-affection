# Build a model-chan sprite pack from its two fitted sheets (fit_cells.py output, 83 x 113 cells, 4 x 4):
#   sheets/daily.png        the 8 schema-1 actions (same layout as bubbo-pixel, so today's loader plays it)
#   sheets/daily_extra.png  the 8 states only DeepSeek's videos had, listed in actions-extra.json for the
#                           character work that extends the pack format; schema 1 ignores the file.
# usage: build_model_chan_pack.py <base.png> <extra.png> <character id> <pack dir>
import json, os, shutil, sys

base, extra, cid, dst = sys.argv[1:5]
here = os.path.dirname(os.path.abspath(__file__))
chars = {c['id']: c for c in json.load(open(os.path.join(here, '..', '..', 'art', 'model-chan', 'characters.json')))['characters']}
c = chars[cid]
BASE = ['idle', 'wave', 'lifted', 'eat', 'sleep', 'think', 'talk', 'cheer']
EXTRA = ['look', 'sad', 'hungry', 'eat_cookie', 'eat_fruit', 'play', 'hatch', 'evolve']
FPS = {'idle': 2, 'wave': 4, 'lifted': 6, 'eat': 3, 'sleep': 1.5, 'think': 2, 'talk': 5, 'cheer': 5,
       'look': 1.5, 'sad': 2, 'hungry': 2, 'eat_cookie': 3, 'eat_fruit': 3, 'play': 4, 'hatch': 2, 'evolve': 4}
# DeepSeek video clip -> sprite action, so every state Dafeiyu has is covered (lifted is sprite-only)
CLIPS = {'idle': 'idle', 'look': 'look', 'happy': 'cheer', 'pat': 'wave', 'sad': 'sad', 'hungry': 'hungry',
         'sleep': 'sleep', 'eat_rice': 'eat', 'eat_cookie': 'eat_cookie', 'eat_fruit': 'eat_fruit', 'think': 'think',
         'talk': 'talk', 'play': 'play', 'hatch': 'hatch', 'evolve': 'evolve'}
pos = lambda names: {a: {'row': i // 2, 'col': (i % 2) * 2, 'frames': 2, 'fps': FPS[a]} for i, a in enumerate(names)}

os.makedirs(os.path.join(dst, 'sheets'), exist_ok=True)
shutil.copyfile(base, os.path.join(dst, 'sheets', 'daily.png'))
shutil.copyfile(extra, os.path.join(dst, 'sheets', 'daily_extra.png'))
license_ = 'CC BY-NC-SA 4.0'
manifest = {
    'schema': 1, 'id': f'{cid}-pixel', 'name': f"{c['nameZh']} · 像素", 'version': '1.0.0',
    'author': 'rdmclin2（gpt-image-2.5 生成，脚本像素化）；原设 ZipZipPipe，设定 lmy414', 'license': license_,
    'description': f"{c['title']}（同人，非 {c['vendor']} 官方）。16 位像素风，8 个标准动作 + 8 个扩展动作（daily_extra.png）。",
    'species': cid, 'kind': 'sprites', 'pixelated': True, 'frame': {'width': 83, 'height': 113},
    'actions': pos(BASE), 'outfits': {'daily': 'sheets/daily.png'},
}
extra_manifest = {
    'sheet': 'sheets/daily_extra.png', 'frame': {'width': 83, 'height': 113}, 'actions': pos(EXTRA),
    'clips': CLIPS,
}
for name, data in (('pack.json', manifest), ('actions-extra.json', extra_manifest)):
    with open(os.path.join(dst, name), 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n')
print(dst, 'ok')
