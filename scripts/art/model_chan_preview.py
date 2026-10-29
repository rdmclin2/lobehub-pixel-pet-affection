# Contact sheet of every model-chan character and state: one column per DeepSeek state plus `lifted`; one row
# per pixel pack showing both frames of the mapped action (1:1), plus a reference row for
# DeepSeek's original video clips (one frame each; `lifted` is dsh-pet's drag clip `lifted.webm`). Needs ffmpeg with libvpx-vp9 for the alpha video frames.
# usage: model_chan_preview.py <out.png> [repo root]
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
root = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
chars = json.load(open(os.path.join(root, 'art/model-chan/characters.json')))['characters']
STATES = chars[0]['art']['states'] + ['lifted']
# (character, row kind): DeepSeek's video reference first, then every pixel pack
rows = [(c, 'video') for c in chars if c['art']['kind'] == 'video'] + [(c, 'pixel') for c in chars if c['art'].get('pack')]
FONT = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
font = lambda size: ImageFont.truetype(FONT, size) if os.path.exists(FONT) else ImageFont.load_default()
SCALE, FW, FH = 1, 166, 226
CW, CH = FW * SCALE * 2 + 12, FH * SCALE + 12  # a column holds both frames side by side
LEFT, TOP, BG = 260, 120, (44, 44, 52, 255)

def video_frame(path):
    with tempfile.TemporaryDirectory() as t:
        png = os.path.join(t, 'f.png')
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-c:v', 'libvpx-vp9', '-ss', '3', '-i', path, '-frames:v', '1', png], check=True)
        im = Image.open(png).convert('RGBA')
    im = im.crop(im.getchannel('A').getbbox())
    im.thumbnail((CW - 12, CH - 12), Image.LANCZOS)
    return im

img = Image.new('RGBA', (LEFT + CW * len(STATES), TOP + CH * len(rows) + 20), BG)
d = ImageDraw.Draw(img)
d.text((20, 20), '模型娘首批角色 · 全部动画状态预览（每格：该状态的帧；像素角色为 2 帧，166×226，原尺寸）', fill='white', font=font(30))
for i, s in enumerate(STATES):
    d.text((LEFT + i * CW + 8, TOP - 40), s, fill=(220, 220, 230), font=font(22))
for r, (c, kind) in enumerate(rows):
    y = TOP + r * CH
    d.rectangle((0, y + 4, LEFT - 12, y + CH - 4), fill=c['accent'])
    d.text((14, y + 20), c['vendor'], fill='white', font=font(28))
    d.text((14, y + 60), c['nameZh'], fill='white', font=font(26))
    d.text((14, y + 98), '原视频（参考）' if kind == 'video' else f"像素 {c['id']}-pixel", fill=(235, 235, 235), font=font(20))
    if kind == 'video':
        clip_dir = os.path.join(root, c['art']['dir'])
        for i, s in enumerate(STATES):
            x = LEFT + i * CW
            f = video_frame(os.path.join(clip_dir, f'{s}.webm'))
            img.alpha_composite(f, (x + (CW - f.width) // 2, y + CH - 6 - f.height))
        continue
    pdir = os.path.join(root, c['art']['pack'])
    pack = json.load(open(os.path.join(pdir, 'pack.json')))  # schema 2: actions are named after the states
    sheet = Image.open(os.path.join(pdir, pack['outfits']['daily'])).convert('RGBA')
    for i, s in enumerate(STATES):
        v = pack['actions'][s]
        for k in range(v['frames']):
            fr = sheet.crop(((v['col'] + k) * FW, v['row'] * FH, (v['col'] + k + 1) * FW, (v['row'] + 1) * FH))
            img.alpha_composite(fr.resize((FW * SCALE, FH * SCALE), Image.NEAREST), (LEFT + i * CW + 6 + k * FW * SCALE, y + 6))
img.convert('RGB').save(out, optimize=True)
print(out, img.size)
