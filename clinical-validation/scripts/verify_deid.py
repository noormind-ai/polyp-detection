r"""Prove the de-identification crop removes the burned-in banner.

    python scripts/verify_deid.py --proof proof.png --montage sheet.jpg

The check is the cross-study MEAN image, before and after the crop, one row per
frame geometry. Averaging one frame from each study washes the tissue to a
smooth field while the identically-placed banner stays crisp, so any surviving
glyph is far more legible here than in any single frame. Contrast is stretched
so faint alpha-blended strokes cannot hide.

This is deliberately a human check on an independent statistic rather than the
de-identifier re-run on its own output -- that can only confirm it agrees with
itself, which is exactly how an earlier detector "passed" on three geometries
where it was in fact finding nothing at all.

"""
import argparse, os, sys
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deid import deid_crop


def sample_one_per_study(root):
    """{(w, h): [gray ndarray, ...]} and {(w, h): [path, ...]}."""
    by_geo, paths = {}, {}
    folders = sorted(d for d in os.listdir(root)
                     if os.path.isdir(os.path.join(root, d)))
    for i, f in enumerate(folders):
        d = os.path.join(root, f)
        jpgs = sorted(j for j in os.listdir(d) if j.lower().endswith('.jpg'))
        if not jpgs:
            continue
        # A mid-procedure frame: the first frame of a study is often the blank
        # white-balance shot, which is near-identical across studies and would
        # average into something that looks like painted-on overlay.
        p = os.path.join(d, jpgs[len(jpgs) // 2])
        try:
            im = Image.open(p).convert('L')
        except Exception:
            continue
        by_geo.setdefault(im.size, []).append(np.asarray(im, dtype=np.uint8))
        paths.setdefault(im.size, []).append(p)
        if i % 50 == 0:
            print('  sampled %d/%d studies' % (i, len(folders)), flush=True)
    return by_geo, paths


def stretch(a):
    lo, hi = np.percentile(a, 2), np.percentile(a, 98)
    return np.clip((a - lo) / max(1e-3, hi - lo) * 255, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--images-root', default=r'F:\colonscopy\Images')
    ap.add_argument('--proof', default='proof.png')
    ap.add_argument('--montage', default=None)
    a = ap.parse_args()

    print('sampling one frame per study...')
    by_geo, paths = sample_one_per_study(a.images_root)

    print('\n%-12s %8s %10s %11s' %
          ('geometry', 'studies', 'crop x0', 'kept'))
    panels = []
    for geo, arrs in sorted(by_geo.items(), key=lambda kv: -len(kv[1])):
        w, h = geo
        mean = np.stack(arrs).astype(np.float32).mean(0)
        crop = deid_crop(Image.fromarray(mean.astype(np.uint8)))
        print('%-12s %8d %10d %11s'
              % ('%dx%d' % geo, len(arrs), crop[0],
                 '%dx%d' % (crop[2] - crop[0], crop[3] - crop[1])))
        after = np.zeros_like(mean)
        after[crop[1]:crop[3], crop[0]:crop[2]] = mean[crop[1]:crop[3], crop[0]:crop[2]]

        pair = Image.new('L', (w * 2 + 12, h + 16), 40)
        pair.paste(Image.fromarray(stretch(mean)), (0, 16))
        pair.paste(Image.fromarray(stretch(after)), (w + 12, 16))
        ImageDraw.Draw(pair).text((4, 3), '%dx%d  n=%d  keep x>=%d'
                                  % (w, h, len(arrs), crop[0]), fill=255)
        panels.append(pair)

    W = max(p.width for p in panels)
    sheet = Image.new('L', (W, sum(p.height + 6 for p in panels)), 40)
    y = 0
    for p in panels:
        sheet.paste(p, (0, y))
        y += p.height + 6
    sheet.save(a.proof)
    print('\nproof ->', a.proof, '  (left = original mean, right = after crop)')

    if a.montage:
        cells, TH = [], 230
        for geo, ps in sorted(paths.items(), key=lambda kv: -len(kv[1])):
            for p in ps[:3]:
                im = Image.open(p).convert('RGB')
                im = im.crop(deid_crop(im))
                im.thumbnail((TH, TH))
                cells.append(im)
        cols = 6
        rows = (len(cells) + cols - 1) // cols
        out = Image.new('RGB', (cols * TH, rows * TH), (20, 20, 20))
        for i, c in enumerate(cells):
            out.paste(c, ((i % cols) * TH, (i // cols) * TH))
        out.save(a.montage, quality=88)
        print('montage ->', a.montage)


if __name__ == '__main__':
    main()
