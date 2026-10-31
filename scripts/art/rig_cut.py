#!/usr/bin/env python3
"""Cut one drawing of a character into the layers of a rig pack (kind "rig", docs/pet-packs.md).

    python3 scripts/art/rig_cut.py art/rig/<id>.json <outfit> <drawing.png> <pack dir>

The spec (art/rig/<id>.json) names each layer with polygons in the drawing's pixels, optionally
narrowed by colour (`hue`: blue-ish hair, say), and says what to paint in where a layer was cut away
so that a part moving a little never shows a hole: `fill` lists polygons that get the colours of the
pixels around them (an even diffusion, good enough for flat anime colours at this size). Layers are
taken in order; a pixel goes to the first layer that claims it, and whatever no layer claims stays
in `rest`. Writes <pack dir>/<outfit>/<layer>.png and the drawing as <outfit>/preview.png, and the layer boxes into <pack dir>/model.json
(parts keep their deformer, z and grid from the spec; the model's units are the drawing's pixels).
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ALPHA_MIN = 24


def poly_mask(shape, polys):
    h, w = shape
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    for p in polys:
        d.polygon([tuple(q) for q in p], fill=255)
    return np.array(m) > 0


def colour_mask(rgba, rule):
    r, g, b = (rgba[..., i] / 255 for i in range(3))
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    if rule == 'blue':
        return (b > r + 0.08) & (s > 0.3)
    if rule == 'not-white':
        return s > 0.18
    raise SystemExit(f'unknown colour rule {rule}')


def dilate(m, n):
    out = m.copy()
    for _ in range(n):
        o = out.copy()
        o[1:] |= out[:-1]
        o[:-1] |= out[1:]
        o[:, 1:] |= out[:, :-1]
        o[:, :-1] |= out[:, 1:]
        out = o
    return out


def diffuse(rgba, hole, steps=400):
    """Paint `hole` with the colours of the opaque pixels next to it, spreading inward."""
    img = rgba.astype(np.float32).copy()
    known = (img[..., 3] > ALPHA_MIN) & ~hole
    col = img[..., :3] * known[..., None]
    wt = known.astype(np.float32)
    todo = hole.copy()
    for _ in range(steps):
        if not todo.any():
            break
        sc = np.zeros_like(col)
        sw = np.zeros_like(wt)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            sc += np.roll(np.roll(col, dy, 0), dx, 1)
            sw += np.roll(np.roll(wt, dy, 0), dx, 1)
        grow = todo & (sw > 0)
        col[grow] = sc[grow] / sw[grow][:, None]
        wt[grow] = 1
        todo &= ~grow
    img[..., :3] = np.where(hole[..., None] & (wt[..., None] > 0), col, img[..., :3])
    img[..., 3] = np.where(hole & (wt > 0), 255, img[..., 3])
    return img


def main():
    spec_path, outfit, drawing, pack_dir = sys.argv[1:5]
    spec = json.load(open(spec_path))
    src = np.array(Image.open(drawing).convert('RGBA')).astype(np.float32)
    h, w = src.shape[:2]
    opaque = src[..., 3] > ALPHA_MIN
    claimed = np.zeros((h, w), bool)
    layers = {}
    for L in spec['layers']:
        m = poly_mask((h, w), L['polys']) if 'polys' in L else np.ones((h, w), bool)
        if 'not' in L:
            m &= ~poly_mask((h, w), L['not'])
        if 'colour' in L:
            m &= colour_mask(src, L['colour'])
        m &= opaque & ~claimed
        claimed |= m
        layers[L['id']] = m
    rest = [L['id'] for L in spec['layers'] if L.get('rest')]
    if rest:
        layers[rest[0]] |= opaque & ~claimed

    os.makedirs(os.path.join(pack_dir, outfit), exist_ok=True)
    # the outfit's picture in lists and the wardrobe (the drawing as it was, uncut)
    Image.fromarray(src.astype(np.uint8)).save(os.path.join(pack_dir, outfit, 'preview.png'))
    boxes = {}
    for L in spec['layers']:
        m = layers[L['id']]
        img = src.copy()
        img[~m] = 0
        for f in L.get('fill', []):
            region = poly_mask((h, w), f['polys'])
            if f.get('within') == 'silhouette':
                region &= dilate(opaque, f.get('grow', 1))
            hole = region & (img[..., 3] <= ALPHA_MIN)
            if f.get('mode') == 'median':
                # one flat colour: the layer's own darker shade (hair behind the head reads as shadow)
                own = img[m & (img[..., :3].max(-1) < 160)]
                img[hole] = [*np.median(own[:, :3], 0), 255] if len(own) else [0, 0, 0, 255]
            else:
                img = diffuse(img, hole)
        a = img[..., 3] > 0
        if not a.any():
            raise SystemExit(f'layer {L["id"]} is empty')
        ys, xs = np.where(a)
        pad = 2
        x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
        x1, y1 = min(w, xs.max() + 1 + pad), min(h, ys.max() + 1 + pad)
        Image.fromarray(img[y0:y1, x0:x1].clip(0, 255).astype(np.uint8)).save(os.path.join(pack_dir, outfit, f'{L["id"]}.png'))
        boxes[L['id']] = [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]

    model_path = os.path.join(pack_dir, 'model.json')
    model = json.load(open(model_path)) if os.path.exists(model_path) else {}
    model['size'] = [w, h]
    parts = []
    for L in spec['layers']:
        p = {'id': L['id'], 'deformer': L['deformer'], 'z': L['z'], 'box': boxes[L['id']]}
        if 'grid' in L:
            p['grid'] = L['grid']
        parts.append(p)
    model['parts'] = parts
    for k in ('pivots', 'face', 'legs'):
        if k in spec:
            model[k] = spec[k]
    with open(model_path, 'w') as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(json.dumps(boxes))


if __name__ == '__main__':
    main()
