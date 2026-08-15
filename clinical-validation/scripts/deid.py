r"""De-identify endoscopy stills by cropping away the burned-in banner column.

WHAT IS ACTUALLY IN THESE IMAGES
--------------------------------
The capture hardware paints a patient banner into the pixels, *inside* the
endoscopic field rather than in the black surround -- so cropping to the field
alone does not remove it, and stripping EXIF does not either: the text is in the
raster.

Surveyed across all 427 studies and all 7 frame geometries, the banner reads:

    ID:        empty in every study
    Name:      empty in every study
    Sex: Age:  empty in every study
    D.O.B.:    empty in every study
    Comment:   empty in every study
    <date>     POPULATED  -- e.g. 10/05/2026
    <time>     POPULATED  -- e.g. 14:20:00
    0/1, Eh:A1 Cm:1, frame counters     device settings, not patient data

So the only identifier actually burned in is the procedure date and time. A date
finer than a year is a quasi-identifier, so it goes, and the empty fields go with
it -- "empty in the ones we checked" is not a control worth relying on.

WHY A CROP AND NOT A MASK
-------------------------
The banner is always a left-hand text column. Two earlier attempts detected the
individual text lines and blacked them out: one keyed on pixels being constant
across studies, which missed almost everything because the glyphs are
alpha-blended (so their variance is suppressed, not zeroed), and a second keyed
on variance suppression plus sharpness in the cross-study mean, which worked on
the two commonest geometries and silently found nothing on three others.

A detector that fails silently on a geometry is the worst possible property for
this job, and verifying it by re-running the same detector on its own output can
only ever confirm it agrees with itself.

Cropping the whole column needs no detector. It costs 13.5% of the model's
detections (measured: those whose box centre lands in the discarded column) --
those frames simply do not enter the review pool, and there are far more
candidates than any reading session needs. In exchange the banner cannot
survive, there are no black bars for a fine-tune to key on, and the reviewer
sees a clean image.

BANNER_W is set with margin: the widest banner measured reaches 0.24 of frame
width, on the 623x532 capture.

USAGE
    out, meta = deid_image(img)                 # cropped, metadata-free
    box = remap_box(box, meta['crop'])          # model boxes into crop space
    keep = box is not None                      # None => box was in the column
"""
import numpy as np
from PIL import Image

# --- endoscopic field detection --------------------------------------------
LUMA_MIN = 40      # a pixel this bright counts as lit
MIN_FRAC = 0.25    # share of an axis that must be lit for a "content" line
INSET = 0.015      # shrink the detected field by this share of its size
MIN_SIDE = 0.30    # a field smaller than this share of the frame is not believed

# --- banner column ---------------------------------------------------------
BANNER_W = 0.30    # discard this share of frame width from the left edge


def _longest_run(mask):
    """Start and end (exclusive) of the longest contiguous True run."""
    best_len = best_start = 0
    cur = None
    for i, v in enumerate(mask):
        if v and cur is None:
            cur = i
        elif not v and cur is not None:
            if i - cur > best_len:
                best_len, best_start = i - cur, cur
            cur = None
    if cur is not None and len(mask) - cur > best_len:
        best_len, best_start = len(mask) - cur, cur
    return best_start, best_start + best_len


def detect_field(img):
    """Bounding box of the endoscopic field as (x0, y0, x1, y1).

    Found by row/column occupancy rather than brightness: the field's rows light
    up a large share of the frame width, while banner text -- which is also
    bright -- lights up a few percent.
    """
    g = np.asarray(img.convert('L'), dtype=np.uint8)
    h, w = g.shape
    lit = g >= LUMA_MIN
    y0, y1 = _longest_run(lit.sum(axis=1) >= MIN_FRAC * w)
    x0, x1 = _longest_run(lit.sum(axis=0) >= MIN_FRAC * h)
    if (y1 - y0) < MIN_SIDE * h or (x1 - x0) < MIN_SIDE * w:
        # All-dark or blown-out frame: fall back to a centred crop.
        mx, my = int(0.10 * w), int(0.10 * h)
        return mx, my, w - mx, h - my
    dx, dy = int(INSET * (x1 - x0)), int(INSET * (y1 - y0))
    return (max(0, x0 + dx), max(0, y0 + dy),
            min(w, x1 - dx), min(h, y1 - dy))


def deid_crop(img):
    """The rectangle to keep: the endoscopic field minus the banner column."""
    w, _ = img.size
    fx0, fy0, fx1, fy1 = detect_field(img)
    return (max(fx0, int(round(BANNER_W * w))), fy0, fx1, fy1)


def deid_image(img):
    """Crop away the banner column and the black surround.

    Save the result without an `exif=` argument: a plain PIL re-encode carries
    no EXIF, JFIF comment or APPn segment forward, so the output has no metadata
    sidecar either.
    """
    img = img.convert('RGB')
    crop = deid_crop(img)
    return img.crop(crop), {'source_size': list(img.size), 'crop': list(crop)}


def remap_box(box, crop):
    """Move [x1, y1, x2, y2, ...] from source pixels into crop pixels.

    Returns None when the box's centre falls outside the kept region -- a
    detection in the discarded column cannot be reviewed, so the frame carrying
    it is dropped rather than shown with the box clipped to the edge.
    """
    x0, y0, x1, y1 = crop
    cx, cy = (float(box[0]) + float(box[2])) / 2, (float(box[1]) + float(box[3])) / 2
    if not (x0 <= cx < x1 and y0 <= cy < y1):
        return None
    bx1 = max(x0, min(x1, float(box[0]))) - x0
    by1 = max(y0, min(y1, float(box[1]))) - y0
    bx2 = max(x0, min(x1, float(box[2]))) - x0
    by2 = max(y0, min(y1, float(box[3]))) - y0
    if bx2 - bx1 < 1 or by2 - by1 < 1:
        return None
    return [round(bx1, 1), round(by1, 1), round(bx2, 1), round(by2, 1)] + list(box[4:])
