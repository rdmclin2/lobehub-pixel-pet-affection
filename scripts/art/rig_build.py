#!/usr/bin/env python3
"""Build a 全动态 rig pack (kind "rig", docs/pet-packs.md) from one master drawing and its edits.

    python3 scripts/art/rig_build.py art/rig/<id>-v2.json <raw dir> <pack dir> [<outfit>]

Every image is gpt-image output on a flat green screen, the same size and framing as the master: the
master itself, and edits of it that change one thing — the arms taken away (`noarms`), the fins taken
away (`nofins`), only the hair left (`haironly`), and one per face (`face_<name>`). Because an edit
leaves the rest of the picture where it was, the difference between an edit and the master is exactly
what it changed, so the layers fall out of the differences instead of being traced by hand:

  hair     the hair-only edit (the hole where the face was is filled with the hair's own colours)
  body     the arms-removed edit inside the dress outline, minus the head, legs and tail
  armL/R   what the master has and the arms-removed edit does not, on each side
  legL/R   the stockings and shoes under the hem, drawn on upward under the skirt
  head     the fins-removed edit inside the head outline (so nothing is missing under the fins)
  finL/R   what the master has and the fins-removed edit does not
  ahoge    the strand above the headdress
  tail     the tail from the arms-removed edit (no hand over it), its root drawn on under the skirt
  faces    each face edit where it differs from the master, feathered: laid over the head

The spec (art/rig/<id>-v2.json) gives the outlines and pivots in master pixels and the frame the pack
is drawn in. Writes <pack dir>/<outfit>/<layer>.png, <outfit>/preview.png and <pack dir>/model.json.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def key(path):
    """RGBA from a green-screen image: alpha from how green a pixel is, the green spill taken out."""
    a = np.array(Image.open(path).convert('RGB')).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    d = g - np.maximum(r, b)
    alpha = np.clip(1 - (d - 30) / 70, 0, 1)
    # no green survives: she has none, and every bit of it is screen showing through (hair edges)
    g2 = np.minimum(g, np.maximum(r, b) * 1.02)
    # and in the blues (hair, dress) a green channel above the red/blue mean is spill turning them teal
    blue = b > r
    g2 = np.where(blue, np.minimum(g2, (r + b) / 2 + 10), g2)
    out = np.dstack([r, g2, b, alpha * 255])
    return out


def poly(shape, polys):
    h, w = shape
    m = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(m)
    for p in polys:
        d.polygon([tuple(q) for q in p], fill=255)
    return np.array(m) > 0


def grow(m, n):
    if n <= 0:
        return m
    return np.array(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2 * n + 1))) > 127


def shrink(m, n):
    if n <= 0:
        return m
    return np.array(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(2 * n + 1))) > 127


def feather(m, r):
    return np.array(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255


def diff(a, b):
    """How different two keyed images are, per pixel (colour and coverage)."""
    ca = a[..., :3] * (a[..., 3:] / 255)
    cb = b[..., :3] * (b[..., 3:] / 255)
    return np.abs(ca - cb).max(-1)


def outside_holes(opaque):
    """Transparent pixels connected to the image border (the rest are holes inside the shape)."""
    h, w = opaque.shape
    seen = np.zeros_like(opaque)
    stack = [(y, x) for x in range(w) for y in (0, h - 1) if not opaque[y, x]] + [(y, x) for y in range(h) for x in (0, w - 1) if not opaque[y, x]]
    for y, x in stack:
        seen[y, x] = True
    while stack:
        y, x = stack.pop()
        for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= yy < h and 0 <= xx < w and not seen[yy, xx] and not opaque[yy, xx]:
                seen[yy, xx] = True
                stack.append((yy, xx))
    return seen


def diffuse(img, hole, steps=600):
    """Paint `hole` with the colours of the opaque pixels around it, spreading inward."""
    img = img.copy()
    known = (img[..., 3] > 200) & ~hole
    col = img[..., :3] * known[..., None]
    wt = known.astype(np.float32)
    todo = hole.copy()
    for _ in range(steps):
        if not todo.any():
            break
        sc = np.zeros_like(col)
        sw = np.zeros_like(wt)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sc += np.roll(np.roll(col, dy, 0), dx, 1)
            sw += np.roll(np.roll(wt, dy, 0), dx, 1)
        g = todo & (sw > 0)
        col[g] = sc[g] / sw[g][:, None]
        wt[g] = 1
        todo &= ~g
    img[..., :3] = np.where(hole[..., None], col, img[..., :3])
    img[..., 3] = np.where(hole, 255, img[..., 3])
    return img


def layer(src, mask, soft=None):
    out = src.copy()
    a = mask.astype(np.float32) if soft is None else soft
    out[..., 3] = src[..., 3] * a
    return out


def main():
    spec_path, raw, pack_dir = sys.argv[1:4]
    outfit = sys.argv[4] if len(sys.argv) > 4 else 'daily'
    spec = json.load(open(spec_path))
    R = lambda n: key(os.path.join(raw, spec['images'][n]))
    master = R('master')
    H, W = master.shape[:2]
    op = master[..., 3] > 128
    P = lambda name: poly((H, W), spec['outlines'][name])
    layers = {}

    # hair: the hair-only edit, its face hole filled with its own colours
    hair = R('haironly')
    hop = hair[..., 3] > 128
    holes = ~hop & ~outside_holes(hop)
    # the hole sits behind the head: one flat colour, the hair's own darker shade
    own = hair[hop & (hair[..., :3].max(-1) < 140)][:, :3]
    hair[holes] = [*np.median(own, 0), 255]
    layers['hair'] = hair

    # head from the fins-removed edit; fins are what that edit took away
    nofins = R('nofins')
    head_m = P('head') & (nofins[..., 3] > 20)
    ahoge_m = P('ahoge') & op
    head_m &= ~ahoge_m
    layers['head'] = layer(nofins, head_m)
    layers['ahoge'] = layer(master, ahoge_m)
    finmask = (diff(master, nofins) > 40) & op & P('fins')
    finmask = grow(shrink(finmask, 1), 2) & op
    for side, name in ((P('finL'), 'fin_l'), (P('finR'), 'fin_r')):
        layers[name] = layer(master, finmask & side)

    # arms: what the master has and the arms-removed edit does not
    noarms = R('noarms')
    armmask = ((diff(master, noarms) > 45) | (op & (noarms[..., 3] < 60))) & op & P('arms')
    armmask = grow(shrink(armmask, 2), 3) & op
    for side, name in ((P('armL'), 'arm_l'), (P('armR'), 'arm_r')):
        layers[name] = layer(master, armmask & side)

    # legs: below the hem, drawn on upward under the skirt by repeating their top rows
    leg_m = P('legs') & op
    for side, name in ((P('legL'), 'leg_l'), (P('legR'), 'leg_r')):
        m = leg_m & side
        img = layer(master, m)
        ys = np.where(m.any(1))[0]
        top = ys.min()
        ext = spec.get('legExtend', 80)
        band = img[top + 4:top + 16]
        for y in range(max(0, top - ext), top + 4):
            img[y] = band[(y - top) % len(band)]
        layers[name] = img

    # tail: from the arms-removed edit, where no hand lies over it; its root drawn on under the skirt
    nop = noarms[..., 3] > 128
    tail_m = P('tail') & nop & ~P('body')  # the skirt's side panel next to it stays with the body
    tail = layer(noarms, tail_m)
    root = P('tailRoot') & ~tail_m & P('body') & nop  # only where the skirt hides it
    tail = diffuse(tail, root)
    layers['tail'] = tail

    # body: the arms-removed edit inside the dress outline, without head, legs and tail
    body_m = P('body') & (noarms[..., 3] > 20) & ~head_m & ~leg_m & ~tail_m
    layers['body'] = layer(noarms, body_m)

    # faces: where each edit differs from the master inside the face, feathered
    face_box = spec['faceBox']
    fpoly = P('face')
    faces = {}
    for name in spec['faces']:
        e = R(f'face_{name}')
        d = (diff(master, e) > spec.get('faceThreshold', 22)) & fpoly
        d = grow(shrink(d, 1), 7)
        soft = feather(d, 3.5) * fpoly
        faces[name] = layer(e, d, soft)

    # into the pack's frame: scale so she is `height` of it, feet on its floor, centred on her body
    fw, fh = spec['frame']
    s = spec['height'] * fh / spec['figureHeight']
    ox = fw / 2 - spec['centerX'] * s
    oy = fh - 2 - spec['feetY'] * s
    T = lambda p: [round(p[0] * s + ox, 2), round(p[1] * s + oy, 2)]

    os.makedirs(os.path.join(pack_dir, outfit), exist_ok=True)

    def save(name, img):
        a = img[..., 3] > 4
        if not a.any():
            raise SystemExit(f'layer {name} is empty')
        ys, xs = np.where(a)
        x0, y0, x1, y1 = max(0, xs.min() - 4), max(0, ys.min() - 4), min(W, xs.max() + 5), min(H, ys.max() + 5)
        crop = img[y0:y1, x0:x1]
        # premultiplied resize, so edges do not darken
        pm = crop.copy()
        pm[..., :3] *= pm[..., 3:] / 255
        tw, th = max(1, round((x1 - x0) * s)), max(1, round((y1 - y0) * s))
        chans = [np.array(Image.fromarray(pm[..., c]).resize((tw, th), Image.LANCZOS)) for c in range(4)]
        out = np.dstack(chans)
        al = np.clip(out[..., 3], 0, 255)
        out[..., :3] = np.where(al[..., None] > 0, out[..., :3] * 255 / np.maximum(al[..., None], 1e-3), 0)
        out[..., 3] = al
        Image.fromarray(out.clip(0, 255).astype(np.uint8)).save(os.path.join(pack_dir, outfit, f'{name}.png'))
        return [round(x0 * s + ox, 2), round(y0 * s + oy, 2), round((x1 - x0) * s, 2), round((y1 - y0) * s, 2)]

    boxes = {name: save(name, img) for name, img in layers.items()}
    for name, img in faces.items():
        boxes[f'face_{name}'] = save(f'face_{name}', img)

    # the picture for lists and the wardrobe: the master in the frame
    pv = Image.new('RGBA', (fw, fh), (0, 0, 0, 0))
    m = Image.fromarray(master.clip(0, 255).astype(np.uint8)).resize((round(W * s), round(H * s)), Image.LANCZOS)
    pv.alpha_composite(m, (round(ox), round(oy)))
    pv.save(os.path.join(pack_dir, outfit, 'preview.png'))

    parts = []
    for L in spec['layers']:
        p = {'id': L['id'], 'deformer': L['deformer'], 'z': L['z'], 'box': boxes[L['id']]}
        if 'grid' in L:
            p['grid'] = L['grid']
        parts.append(p)
    z = max(L['z'] for L in spec['layers'] if L['id'] == 'head') + 0.2
    for i, name in enumerate(spec['faces']):
        parts.append({'id': f'face_{name}', 'deformer': 'head', 'z': round(z + (0.1 if name in ('blink', 'talk') else 0) + i * 0.001, 3), 'box': boxes[f'face_{name}'], 'grid': [3, 3]})
    model = {
        'size': [fw, fh],
        'parts': parts,
        'pivots': {k: T(v) for k, v in spec['pivots'].items()},
        'legs': {'hem': T([0, spec['hemY']])[1], 'feet': fh - 2, 'split': fw / 2},
        'expressions': {name: f'face_{name}' for name in spec['faces']},
    }
    with open(os.path.join(pack_dir, 'model.json'), 'w') as f:
        json.dump(model, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(json.dumps({k: v for k, v in boxes.items()}))


if __name__ == '__main__':
    main()
