#!/usr/bin/env python3
"""make_art.py — turn the hand-picked line-art JPEGs in art/src/ into
site-ready transparent PNGs in art/.

The originals are kept pixel-exact: the paper background is knocked out
(luminance -> alpha) and the ink strokes are tinted to the site palette.
The garden strip is composed from individual flowers/stems cut out of the
scattered-flower sheets.

Usage:  python3 scripts/make_art.py
"""

import os
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'art', 'src')
OUT = os.path.join(ROOT, 'art')

INK = (0x1a, 0x1a, 0x18)      # near-black warm ink
OXBLOOD = (0x73, 0x2b, 0x2b)  # the site's one warm accent


def load_gray(name):
    im = Image.open(os.path.join(SRC, name)).convert('L')
    return np.asarray(im, dtype=np.float32)


def ink_alpha(g):
    """Luminance -> alpha: paper transparent, ink opaque, smooth in between."""
    bg = np.percentile(g, 75)          # paper level (background dominates)
    ink = np.percentile(g, 0.5)        # darkest strokes
    hi = bg - 0.12 * (bg - ink)        # ignore paper grain near the bg level
    a = np.clip((hi - g) / max(hi - ink, 1.0), 0.0, 1.0)
    return a ** 0.85                   # keep thin strokes readable


def tinted(alpha, color):
    h, w = alpha.shape
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = color
    out[..., 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def cutout(name, color=INK):
    return tinted(ink_alpha(load_gray(name)), color)


def components(alpha, merge_px=6, min_area=250):
    """Connected ink motifs (dilated so one motif's disjoint strokes merge).
    Returns (bbox slice, own-pixels mask) pairs so a crop never drags in
    fragments of a neighbouring motif that shares its bounding box."""
    mask = alpha > 0.35
    merged = ndimage.binary_dilation(mask, iterations=merge_px)
    labels, n = ndimage.label(merged)
    out = []
    for idx, sl in enumerate(ndimage.find_objects(labels), start=1):
        if sl is None:
            continue
        own = mask[sl] & (labels[sl] == idx)
        if own.sum() < min_area:
            continue
        out.append((sl, ndimage.binary_dilation(own, iterations=2)))
    out.sort(key=lambda t: -(t[0][0].stop - t[0][0].start) * (t[0][1].stop - t[0][1].start))
    return out


def crop(alpha, comp, color):
    sl, own = comp
    return tinted(alpha[sl] * own, color)


def scaled(im, height):
    w = max(1, round(im.width * height / im.height))
    return im.resize((w, height), Image.LANCZOS)


def make_garden():
    """A garden-bed strip: stems planted on a baseline, flower heads among
    them. Deterministic layout (seeded) so rebuilds are stable."""
    rng = np.random.default_rng(11)

    heads_a = ink_alpha(load_gray('images-7.jpeg'))     # 6x10 grid of blooms
    wild_a = ink_alpha(load_gray('images-6.jpeg'))      # 11 wildflower stems
    doodle_a = ink_alpha(load_gray('images-4.jpeg'))    # doodle garden sheet
    sprig_a = ink_alpha(load_gray('images-5.jpeg'))     # 6 minimal sprigs

    stems = []
    for a in (wild_a, sprig_a):
        for comp in components(a, merge_px=5, min_area=400):
            sl = comp[0]
            h = sl[0].stop - sl[0].start
            w = sl[1].stop - sl[1].start
            if h > 90 and h > 1.1 * w:                  # tall = a stem
                stems.append((a, comp))
    for comp in components(doodle_a, merge_px=4, min_area=500):
        sl = comp[0]
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        if h > 110 and h > 1.4 * w:
            stems.append((doodle_a, comp))

    heads = []
    for comp in components(heads_a, merge_px=4, min_area=200):
        sl = comp[0]
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        if 20 < h < 110 and 20 < w < 110 and 0.6 < h / w < 1.7:
            heads.append(comp)
    rng.shuffle(heads)

    W, H = 2200, 560
    base = H - 14                                       # planting line
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))

    # stems across the strip, varied heights, slight overlap
    n_stems = 16
    xs = np.linspace(40, W - 220, n_stems) + rng.uniform(-30, 30, n_stems)
    order = rng.permutation(len(stems))
    for i, x in enumerate(xs):
        a, comp = stems[order[i % len(stems)]]
        hgt = int(rng.uniform(280, 440))
        color = OXBLOOD if rng.random() < 0.15 else INK
        piece = scaled(crop(a, comp, color), hgt)
        if rng.random() < 0.5:
            piece = piece.transpose(Image.FLIP_LEFT_RIGHT)
        out.alpha_composite(piece, (int(x), base - piece.height))

    # flower heads low in the bed, filling the gaps between stems
    n_heads = 26
    hx = np.linspace(10, W - 130, n_heads) + rng.uniform(-40, 40, n_heads)
    for i, x in enumerate(hx):
        comp = heads[i % len(heads)]
        hgt = int(rng.uniform(60, 120))
        color = OXBLOOD if rng.random() < 0.35 else INK
        piece = scaled(crop(heads_a, comp, color), hgt)
        y = base - piece.height - int(rng.uniform(0, 70))
        out.alpha_composite(piece, (int(x), y))

    out.save(os.path.join(OUT, 'garden.png'))
    print('garden.png', out.size)


def main():
    os.makedirs(OUT, exist_ok=True)
    for src, dst in [('images.jpeg', 'spiral.png'),
                     ('images-3.jpeg', 'waves.png'),
                     ('images-5.jpeg', 'sprigs.png'),
                     ('images-6.jpeg', 'wildflowers.png')]:
        im = cutout(src)
        im.save(os.path.join(OUT, dst))
        print(dst, im.size)
    make_garden()


if __name__ == '__main__':
    main()
