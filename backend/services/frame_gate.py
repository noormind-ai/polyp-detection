"""Frame-quality gate for live inference.

Runs on the frame the CPU path has ALREADY decoded (`local_cpu._infer_sync`),
so the marginal cost is the metric arithmetic alone -- no second decode, no
resize to a second model's input size, no second ONNX session and therefore
none of the thread-pool contention that makes adding a real classifier cost
~2.8x.

Measured cost of the default four-filter bank: **3.7 ms/frame**, against ~40 ms
for the detector. Of that, 2.1 ms is the shared downsample-and-grey in `_prep`
and 2.2 ms is `gra1` alone; the other three filters together are 1.0 ms. Cost
scales with what `POLYP_GATE_KEEP` asks for, not with the twelve implemented,
and the two most expensive filters here (`dft` 7.3 ms, `edgewidth` 2.3 ms) are
both out of the default bank -- which is convenient, because they are also two
of the three worst performers.

WHY THESE FILTERS
-----------------
Twelve cheap operators are implemented and measured against 246 frames labelled
for blur by a reviewer (see NOISE-GATE-BENCH.md). AUC, and what each catches at
the shared operating point that costs 2.2% of doctor-confirmed polyp frames:

                                        AUC    catches
    gra1   (Sobel gradient mean)       0.816     20.7%   <- the enforcing filter
    bren   (Brenner 1976)              0.782     18.5%
    teng   (Tenengrad)                 0.770      9.8%
    lapv   (Laplacian variance)        0.759     10.9%
    lapm   (modified Laplacian)        0.759      8.7%
    edged  (Canny edge density)        0.735     23.9%
    wavelet (Tong 2004)                0.634      4.3%
    ipr    (Oh 2007, edge continuity)  0.630      0.0%
    sat    (HSV saturation)            0.628     35.9%
    dft    (high-frequency share)      0.616      4.3%
    glva   (grey-level variance)       0.590     19.6%
    edgewidth (Marziliano 2002)        0.567     12.0%

Three things in that table are worth not forgetting.

The endoscopy literature's own methods lose. Oh 2007's edge continuity and
Marziliano 2002's edge width -- the two the field cites for exactly this problem
-- come last. `ipr` catches literally nothing at a usable operating point: most
frames share its floor value, so the tie block is wider than the budget and
there is no threshold to place.

AUC and catch rate disagree, sharply. `sat` is 11th of 12 by AUC and 1st by what
it actually catches. AUC ranks the whole ordering; a gate only ever lives at one
threshold. Rank by the column you are going to operate at.

The filters are not independent, except for one. Jaccard overlap of the frames
they fire on: gra1/edged 0.44, gra1/lapv 0.27 -- the sharpness operators are
largely re-reading each other. gra1/sat is 0.12. That is the argument for `sat`
in one number: it is the only filter here that fails on different frames.

REPORT-ONLY BY DEFAULT
----------------------
`POLYP_GATE_ENFORCE` defaults to off. The gate is computed and reported on every
frame, but detections are NOT suppressed until someone turns enforcement on
deliberately. Silently muting a detector in a clinical demo is not a thing to
switch on as a side effect of a deploy -- and at the fitted cut this gate still
mutes ~1.7% of frames a doctor called `polyp`, which is a decision for a
clinician, not a config default.

    POLYP_GATE=gra1            which filter enforces (or "off")
    POLYP_GATE_CUT=14.675      fitted: catches 20.7% of blurry frames while
                               muting 2.2% of doctor-confirmed polyp frames
    POLYP_GATE_ENFORCE=1       actually drop boxes; otherwise report only
    POLYP_GATE_KEEP=...        which filters are computed and reported
    POLYP_GATE_CUTS=...        path to cuts.json (see fit_cuts.py)
    POLYP_GATE_BANK=0          compute only the enforcing filter

A NOTE ON COMBINING THEM
------------------------
Tested, not adopted. OR-ing all four catches 55.4% of blurry frames but costs
6.7% of polyp frames -- 3x the budget, which is a different gate, not a better
one. A 2-of-4 vote holds the cost at 2.2% and catches 26.1% against gra1's
20.7% on the reviewer's labels, but 15.3% against 16.8% on the doctor's. The two
label sets disagree about whether it helps, on 92 and 274 positives, so it is
inside the noise. `gra1` alone stays the enforcing filter until there is a
labelled set big enough to settle it.
"""
import os

import cv2
import numpy as np

SMALL = 256  # longest side; the fitted cuts assume this, so do not change alone

NAME = os.getenv("POLYP_GATE", "gra1").strip().lower()
ENFORCE = os.getenv("POLYP_GATE_ENFORCE", "").strip() in ("1", "true", "yes", "on")

# Cuts fitted by compute_filters.py on the reviewer's blur labels, at the
# operating point that mutes at most 2% of doctor-confirmed polyp frames.
# Stored in SIGN-FLIPPED space: a filter fires when `sign * value < cut`.
# Read from the fit rather than typed here -- transcribing them by hand is what
# left ipr/wavelet/edgewidth firing on every frame.
_FALLBACK = {
    "gra1": (1, 14.675), "teng": (1, 878.59), "lapv": (1, 78.113),
    "lapm": (1, 4.9911), "glva": (1, 653.03), "bren": (1, 26.014),
    "edged": (1, 0.0044698), "dft": (1, 0.015903), "ipr": (-1, -1.0),
    "wavelet": (-1, -1.4317), "edgewidth": (-1, -0.52567), "sat": (-1, -190.79),
}


def _load_cuts():
    path = os.getenv("POLYP_GATE_CUTS",
                     "/home/fati/noormind/noisy-review-data/cuts.json")
    try:
        import json
        with open(path) as fh:
            d = json.load(fh)
        return {k: (int(v["sign"]), float(v["cut"])) for k, v in d.items()}
    except Exception:
        return dict(_FALLBACK)


CUTS = _load_cuts()
CUT = float(os.getenv("POLYP_GATE_CUT", CUTS.get(NAME, (1, 0.0))[1]))
# Report the whole bank, not only the enforcing filter. Off-switch is provided
# because it is the difference between 2.1 ms (prep) + 2.2 ms (gra1 alone) and
# 3.7 ms for the default four.
BANK = os.getenv("POLYP_GATE_BANK", "1").strip() not in ("0", "false", "no", "off")

LABELS = {
    "gra1": "Sobel mean (GRA1)",
    "teng": "Tenengrad",
    "lapv": "Laplacian variance",
    "lapm": "Modified Laplacian",
    "glva": "Grey-level variance",
    "bren": "Brenner gradient",
    "edged": "Edge density (Canny)",
    "sat": "Colour saturation",
    "dft": "DFT high-freq ratio",
    "ipr": "IPR (Oh 2007)",
    "wavelet": "Wavelet (Tong 2004)",
    "edgewidth": "Edge width (Marziliano)",
}
SIGN = CUTS.get(NAME, (1, 0.0))[0]


def _prep(bgr):
    """-> (downsampled BGR, its grey). Both, because `sat` needs the colour and
    everything else needs the grey, and neither should decode or resize twice."""
    h, w = bgr.shape[:2]
    if max(h, w) > SMALL:
        r = SMALL / max(h, w)
        bgr = cv2.resize(bgr, (max(1, int(w * r)), max(1, int(h * r))),
                         interpolation=cv2.INTER_AREA)
    return bgr, cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


def _gra1(g):
    f = g.astype(np.float32)
    gx = cv2.Sobel(f, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(f, cv2.CV_32F, 0, 1, ksize=3)
    return float(np.sqrt(gx * gx + gy * gy).mean())


def _teng(g):
    f = g.astype(np.float32)
    gx = cv2.Sobel(f, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(f, cv2.CV_32F, 0, 1, ksize=3)
    return float((gx * gx + gy * gy).mean())


def _lapv(g):
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def _lapm(g):
    f = g.astype(np.float32)
    kx = np.array([[-1, 2, -1]], np.float32)
    return float((np.abs(cv2.filter2D(f, cv2.CV_32F, kx)) +
                  np.abs(cv2.filter2D(f, cv2.CV_32F, kx.T))).mean())


def _glva(g):
    return float(g.astype(np.float32).var())


def _dft(g, cutoff=0.25):
    f = g.astype(np.float32) / 255.0
    f = f - f.mean()
    F = np.fft.fftshift(np.abs(np.fft.fft2(f)) ** 2)
    h, w = F.shape
    y, x = np.ogrid[:h, :w]
    r = np.sqrt(((y - h / 2) / (h / 2)) ** 2 + ((x - w / 2) / (w / 2)) ** 2)
    tot = float(F.sum())
    return float(F[r > cutoff].sum() / tot) if tot > 0 else 0.0


def _ipr(g):
    edges = cv2.Canny(g, 50, 150) > 0
    total = int(edges.sum())
    if total < 30:
        return 0.0
    e = edges.astype(np.uint8)
    nb = cv2.filter2D(e, cv2.CV_16U, np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.uint8),
                      borderType=cv2.BORDER_CONSTANT)
    return int(((nb > 0) & edges).sum()) / total


def _wavelet(g):
    f = g.astype(np.float32)

    def haar(a):
        a = a[:a.shape[0] // 2 * 2, :a.shape[1] // 2 * 2]
        lo, hi = (a[0::2, :] + a[1::2, :]) / 2, (a[0::2, :] - a[1::2, :]) / 2
        return ((lo[:, 0::2] + lo[:, 1::2]) / 2,
                ((lo[:, 0::2] - lo[:, 1::2]) / 2,
                 (hi[:, 0::2] + hi[:, 1::2]) / 2,
                 (hi[:, 0::2] - hi[:, 1::2]) / 2))

    l1, d1 = haar(f)
    _, d2 = haar(l1)
    e1 = float(sum((d ** 2).mean() for d in d1))
    e2 = float(sum((d ** 2).mean() for d in d2))
    return e1 / e2 if e2 > 1e-9 else 0.0


def _edgewidth(g):
    a = g.astype(np.int16)
    edges = cv2.Canny(g, 50, 150) > 0
    ys, xs = np.nonzero(edges)
    if len(ys) < 30:
        return 0.0
    if len(ys) > 400:
        sel = np.linspace(0, len(ys) - 1, 400).astype(int)
        ys, xs = ys[sel], xs[sel]
    w = a.shape[1]
    widths = []
    for y, x in zip(ys, xs):
        row = a[y]
        i = x
        while i > 0 and row[i - 1] <= row[i]:
            i -= 1
        j = x
        while j < w - 1 and row[j + 1] >= row[j]:
            j += 1
        widths.append(j - i + 1)
    m = float(np.mean(widths))
    return 1.0 / m if m > 0 else 0.0


def _bren(g):
    """Brenner 1976 gradient: two-pixel horizontal difference, squared.

    Cheapest thing in the bank (~0.13 ms) and second-best overall on both label
    sets (0.719 doctor / 0.773 reviewer). It is still first-derivative energy,
    so by the family rule below it does not displace gra1 -- it is here so the
    claim can be re-checked rather than re-argued."""
    f = g.astype(np.float32)
    d = f[:, 2:] - f[:, :-2]
    return float((d * d).mean())


def _edged(g):
    """Canny edge density -- how much resolvable structure is present at all.

    Oh 2007 uses this alongside IPR and treats IPR as the interesting one. On
    our footage it is the other way round: 0.677 vs 0.632 on the doctor's
    labels, 0.737 vs 0.670 on the reviewer's. IPR divides by the edge count and
    throws away exactly the signal that turns out to matter."""
    return float((cv2.Canny(g, 50, 150) > 0).mean())


def _sat(bgr):
    """Mean HSV saturation -- the one filter here that is not a focus operator.

    Every sharpness operator in this file fails on the same frames. On
    anal-canal views gra1 drops to 0.658 and edgewidth inverts to 0.226; on
    retained-water frames lapv inverts to 0.453. Those are dark, smooth,
    low-gradient views that are physically indistinguishable from defocus to
    anything measuring gradient energy. Saturation is the only cheap measure
    that holds up there -- 0.796 on anal canal, 0.630 on water -- which is why
    it earns a slot that a tenth sharpness operator would not.

    Note the sign. HIGH saturation predicts *unreadable*, on both readers'
    labels. That is red-out and wall contact, not the specular washout the
    original tier1 rules assumed -- spec_frac runs backwards on this corpus."""
    return float(cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[:, :, 1].mean())


_ALL = {"gra1": _gra1, "teng": _teng, "lapv": _lapv, "lapm": _lapm,
        "glva": _glva, "bren": _bren, "edged": _edged, "dft": _dft,
        "ipr": _ipr, "wavelet": _wavelet, "edgewidth": _edgewidth,
        "sat": _sat}

# The filters that read colour instead of the grey plane.
NEEDS_COLOUR = {"sat"}

# Twelve are implemented; four are kept. The cut is by MECHANISM, not by rank --
# keeping the top four by AUC would keep gra1, bren and teng, which are all
# first-derivative energy and therefore say the same thing three times. One
# survivor per family, the best of each:
#
#   gra1     0.816  first-derivative energy   (beats bren 0.773, teng 0.770)
#   lapv     0.759  second-derivative energy  (ties lapm 0.759)
#   edged    0.737  edge / structure density  (beats ipr 0.670 -- see _edged)
#   sat      0.629  colour, NOT focus         -- see _sat; this is the point
#
# `sat` is the low scorer of the four and is kept anyway, deliberately. The
# other eleven filters fail on the same frames as each other (anal canal, water,
# any dark smooth view); a fourth sharpness operator would add a fourth
# correlated vote, and sat is the only measured alternative that is still
# standing where the rest fall over. Four filters with three mechanisms beats
# four filters with one.
#
# Dropped: teng/bren/lapm (same family as a better filter), ipr (same family as
# edged, and worse), wavelet 0.634 and dft 0.616 (multi-scale detail ratio --
# the whole family underperforms), glva 0.590, edgewidth 0.571 (close enough to
# a coin flip that a red chip from it means nothing, and 16 ms besides).
# All are still in _ALL and can be switched back on with POLYP_GATE_KEEP.
KEEP = [n.strip() for n in
        os.getenv("POLYP_GATE_KEEP", "gra1,lapv,edged,sat").split(",") if n.strip()]
FILTERS = {n: _ALL[n] for n in KEEP if n in _ALL}


def check(frame) -> dict | None:
    """-> the whole filter bank evaluated on an already-decoded BGR frame.

    Every filter is computed, not just the enforcing one, because the point of
    the live readout is to watch all nine disagree with each other on real
    footage. Only `filter` decides whether boxes are dropped.

    The downsample and grey conversion are done ONCE and shared, so the whole
    bank costs barely more than one filter.
    """
    fn = FILTERS.get(NAME)
    if fn is None and not BANK:
        return None
    bgr, g = _prep(frame)

    out = {}
    for n, f in (FILTERS.items() if BANK else [(NAME, fn)]):
        sign, cut = CUTS.get(n, (1, 0.0))
        if n == NAME:
            cut = CUT
        try:
            v = f(bgr if n in NEEDS_COLOUR else g)
        except Exception:
            continue
        out[n] = {"value": round(v, 4), "cut": round(cut, 4),
                  "fired": bool(sign * v < cut), "label": LABELS.get(n, n)}

    main = out.get(NAME)
    return {
        "filter": NAME,
        "value": main["value"] if main else None,
        "cut": round(CUT, 4),
        "fired": bool(main["fired"]) if main else False,
        "enforce": ENFORCE,
        "filters": out,
    }
