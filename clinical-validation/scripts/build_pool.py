r"""Build the offline review pool: de-identified images + pool.jsonl.

    python scripts/build_pool.py --out build

Runs entirely on this machine. Nothing here reaches a server until the output
directory is uploaded, and the crosswalk mapping a case label back to a real
study folder is written OUTSIDE that directory on purpose -- see PSEUDONYMS.

THE PROBLEM THIS POOL EXISTS TO FIX
-----------------------------------
The only labels we have are per PATIENT, read out of the colonoscopy report:
"this procedure found a 7 mm sessile polyp in the ascending colon". They say
nothing about which saved still shows it, or whether any of them does.

The model works per FRAME. So every number in the evaluation -- the 0.70
confidence threshold, the "3 flagged frames makes a study positive" rule -- is
tuned against a label that carries no frame-level information. A study counted
TP does not mean the model fired on the right image, and a study counted FP may
be a lesion the report simply does not record.

This pool turns those four patient-level cells into per-frame questions:

  fp   frame the model fired on, in a report-negative study. Taken WHOLE: a
       "no" is a confirmed false positive and a hard negative; a "yes" is a
       possible lesion the report missed, which is the clinically interesting
       outcome.
  fn   EVERY frame of a report-positive study the model called negative, each
       asked independently. We do not know whether the lesion was captured in
       any still, so a reader must be able to say no to all of them and be
       right -- which is why this is not a pick-from-the-grid task.
  tp   frames the model fired on in an agreed-positive study. Not filler: the
       report says the PATIENT has a polyp, not that this FRAME shows it, so
       these test whether the model fired on the right image.
  tn   quiet frames in report-negative studies. The control, and the only
       group that is sampled rather than taken whole.

SAMPLING AND WEIGHTS
--------------------
FP, TP and FN are exhaustive, so they carry weight 1.0. There are 4302 quiet
frames and shipping all of them would bury the pool, so TN is a small random
sample and every TN item carries the inverse sampling fraction. Any frame-level
specificity computed without applying that weight describes the sample, not the
archive.

An overlap set -- a fixed random share of each group -- is marked so that
readers are steered onto common items and inter-reader agreement is measured on
a designed subset rather than on whatever happened to collide.

PSEUDONYMS
----------
Every study gets a case label ("C-0137") drawn in shuffled order, and every item
an opaque content-addressed id. The mapping back to the real folder and
reception id goes to crosswalk.csv, which stays on this machine, so a compromise
of the panel does not re-identify anyone.

DE-IDENTIFICATION
-----------------
Every image is cropped to remove the burned-in patient banner and re-encoded
without metadata -- see deid.py for what is in these images and why a crop
rather than a mask. Model boxes are remapped into crop coordinates.
"""
import argparse, collections, csv, hashlib, json, os, random, re, sys
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deid import deid_image, remap_box

csv.field_size_limit(10 ** 7)

# Identifiers that could ride along in the free-text report. The reports are
# clinical prose with no name field, but they do carry dates and record numbers.
SCRUB = [
    (re.compile(r'\b\d{4}/\d{1,2}/\d{1,2}\b'), '[date]'),      # 1397/06/18
    (re.compile(r'\b\d{1,2}/\d{1,2}/\d{4}\b'), '[date]'),      # 15/02/2026
    (re.compile(r'\b\d{5,}\b'), '[id]'),                       # record numbers
]


def scrub(text):
    if not text:
        return ''
    for rx, rep in SCRUB:
        text = rx.sub(rep, text)
    return text.strip()


def load_preds(path):
    """{filename: {conf, boxes, error}}."""
    out = {}
    with open(path, encoding='utf-8-sig', newline='') as fh:
        for r in csv.DictReader(fh):
            try:
                conf = float(r.get('max_conf') or 0)
            except ValueError:
                conf = 0.0
            boxes = []
            if r.get('boxes'):
                try:
                    boxes = json.loads(r['boxes'])
                except Exception:
                    boxes = []
            out[r['file']] = {'conf': conf, 'boxes': boxes,
                              'error': (r.get('error') or '').strip()}
    return out


def assemble(labels_path, preds, images_root):
    """Evaluable studies, by the same rules eval_polyp.py uses.

    A study counts only when every one of its frames has a prediction row --
    a missing row is otherwise indistinguishable from a frame the model cleared.
    """
    studies, skipped = [], collections.Counter()
    with open(labels_path, encoding='utf-8-sig', newline='') as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        if r['operation_type'] != 'Colonoscopy':
            skipped['not colonoscopy'] += 1
            continue
        d = os.path.join(images_root, r['folder'])
        if not os.path.isdir(d):
            skipped['no images on disk'] += 1
            continue
        files = sorted(f for f in os.listdir(d) if f.lower().endswith('.jpg'))
        if not files:
            skipped['empty folder'] += 1
            continue
        if any(f not in preds or preds[f]['error'] for f in files):
            skipped['partially/not inferred'] += 1
            continue
        studies.append(dict(
            folder=r['folder'], dir=d, files=files,
            gt=r['polyp_exists'] == '1',
            confs=[preds[f]['conf'] for f in files],
            rid=r['reception_id'], date=r['reception_date'],
            morph=r['polyp_morphology'], size=r['polyp_max_mm'],
            where=r['polyp_where'], evidence=r['polyp_evidence'],
            report=r['report']))
    return studies, skipped


def emit_image(src, dst_dir, cache):
    """De-identify one frame; returns (relpath, w, h, crop) or None."""
    if src in cache:
        return cache[src]
    try:
        with Image.open(src) as im:
            out, meta = deid_image(im)
    except Exception:
        cache[src] = None
        return None
    # Content-addressed so the filename leaks nothing and re-runs are stable.
    h = hashlib.sha256(out.tobytes()).hexdigest()[:20]
    rel = os.path.join(h[:2], h + '.jpg')
    full = os.path.join(dst_dir, rel)
    if not os.path.exists(full):
        os.makedirs(os.path.dirname(full), exist_ok=True)
        out.save(full, 'JPEG', quality=92)   # no exif= : re-encode drops metadata
    res = (rel.replace('\\', '/'), out.size[0], out.size[1], meta['crop'])
    cache[src] = res
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--labels', default=r'F:\codes\noormind\data\labels\labels.csv')
    ap.add_argument('--preds', default=r'F:\codes\noormind\data\preds-yolov5m-baseline.csv')
    ap.add_argument('--images-root', default=r'F:\colonscopy\Images')
    ap.add_argument('--out', default='build')
    ap.add_argument('--crosswalk', default='crosswalk.csv',
                    help='written OUTSIDE --out; never upload this')
    ap.add_argument('--conf', type=float, default=0.70, help='operating point')
    ap.add_argument('--min-frames', type=int, default=3,
                    help='flagged frames needed to call a study AI-positive')
    ap.add_argument('--fp-conf', type=float, default=0.30,
                    help='a frame this confident in a report-negative study is '
                         'an FP candidate. 0.30 is the floor of the eval sweep, '
                         'so the pool holds every frame the model fires on at '
                         'all, not just those over the operating point')
    ap.add_argument('--tn-max-conf', type=float, default=0.25,
                    help='a frame quieter than this, in a report-negative '
                         'study, is a clean control')
    ap.add_argument('--cap-fp', type=int, default=0, help='FP frames per study, 0 = all')
    ap.add_argument('--cap-tp', type=int, default=0, help='TP frames per study, 0 = all')
    ap.add_argument('--cap-tn', type=int, default=2, help='TN frames per study, 0 = all')
    ap.add_argument('--overlap', type=float, default=0.12,
                    help='share of items readers are steered onto in common, so '
                         'inter-reader agreement has a designed set to sit on')
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args()

    cap = lambda n, seq: seq if n <= 0 else seq[:n]   # 0 means no cap
    rnd = random.Random(a.seed)
    img_dir = os.path.join(a.out, 'images')
    os.makedirs(img_dir, exist_ok=True)

    print('loading predictions...')
    preds = load_preds(a.preds)
    studies, skipped = assemble(a.labels, preds, a.images_root)
    print('evaluable studies: %d   (%s)' % (
        len(studies), ', '.join('%s=%d' % kv for kv in sorted(skipped.items()))))

    order = list(range(len(studies)))
    rnd.shuffle(order)
    for n, i in enumerate(order):
        studies[i]['case'] = 'C-%04d' % (n + 1)

    items, out_studies, cache = [], [], {}
    counts = collections.Counter()
    n_quiet_total = n_quiet_taken = 0

    for si, s in enumerate(studies):
        nf = sum(1 for c in s['confs'] if c >= a.conf)
        ai_pos = nf >= a.min_frames
        s['verdict'] = ('TP' if s['gt'] and ai_pos else 'FN' if s['gt']
                        else 'FP' if ai_pos else 'TN')

        # Every frame of every pooled study is de-identified, not just the ones
        # that become questions: the escalation views show the whole study, so
        # the frames nobody was asked about still need to exist as files.
        frames, index_of = [], {}
        for f in s['files']:
            got = emit_image(os.path.join(s['dir'], f), img_dir, cache)
            if not got:
                continue
            rel, w, h, crop = got
            index_of[f] = len(frames)
            frames.append(dict(image=rel, w=w, h=h, crop=crop,
                               ai_conf=round(preds[f]['conf'], 4)))
        if not frames:
            continue

        out_studies.append(dict(
            case=s['case'], verdict=s['verdict'], report_polyp=int(s['gt']),
            report_scrubbed=scrub(s['report']), finding=scrub(s['evidence']),
            polyp_max_mm=s['size'], polyp_morphology=s['morph'],
            polyp_location=s['where'], n_frames=len(frames),
            frames=[{k: fr[k] for k in ('image', 'w', 'h', 'ai_conf')}
                    for fr in frames]))

        def add(f, bucket):
            i = index_of.get(f)
            if i is None:
                return
            fr = frames[i]
            boxes = [b for b in (remap_box(bx, fr['crop'])
                                 for bx in preds[f]['boxes']) if b]
            items.append(dict(bucket=bucket, case=s['case'], frame_index=i,
                              image=fr['image'], w=fr['w'], h=fr['h'],
                              ai_conf=fr['ai_conf'], ai_boxes=boxes,
                              sampling_weight=1.0))
            counts[bucket] += 1

        by_conf = sorted(zip(s['files'], s['confs']), key=lambda t: -t[1])

        if not s['gt']:
            for f, _ in cap(a.cap_fp, [t for t in by_conf if t[1] >= a.fp_conf]):
                add(f, 'fp')
            # Per frame, not per study: there is no wholly silent study to draw
            # controls from -- all 77 report-negative studies have at least one
            # frame flagged at 0.30, as the eval's detection curve already showed.
            quiet = [f for f, c in zip(s['files'], s['confs']) if c < a.tn_max_conf]
            n_quiet_total += len(quiet)
            take = len(quiet) if a.cap_tn <= 0 else min(a.cap_tn, len(quiet))
            for f in rnd.sample(quiet, take):
                n_quiet_taken += 1
                add(f, 'tn')
        elif ai_pos:
            for f, _ in cap(a.cap_tp, [t for t in by_conf if t[1] >= a.conf]):
                add(f, 'tp')
        else:
            for f in s['files']:
                add(f, 'fn')

    if n_quiet_taken:
        w = round(n_quiet_total / float(n_quiet_taken), 4)
        for it in items:
            if it['bucket'] == 'tn':
                it['sampling_weight'] = w

    for it in items:
        it['id'] = hashlib.sha256(
            (it['bucket'] + it['case'] + it['image']).encode()).hexdigest()[:16]

    # Studies contain byte-identical repeat frames -- the endoscopist pressed
    # capture twice on one view. Those collapse to a single content-addressed
    # image and therefore a single id, so drop them here rather than letting the
    # import absorb them silently and report a different total.
    dedup, seen_ids = [], set()
    for it in items:
        if it['id'] not in seen_ids:
            seen_ids.add(it['id'])
            dedup.append(it)
    n_dupes = len(items) - len(dedup)
    items = dedup
    counts = collections.Counter(it['bucket'] for it in items)

    # Overlap set, stratified by bucket so agreement is measurable within each
    # group rather than only in aggregate.
    for it in items:
        it['in_overlap'] = 0
    for bucket in counts:
        pool = [it for it in items if it['bucket'] == bucket]
        for it in rnd.sample(pool, int(round(a.overlap * len(pool)))):
            it['in_overlap'] = 1

    rnd.shuffle(items)
    out_path = os.path.join(a.out, 'pool.jsonl')
    with open(out_path, 'w', encoding='utf-8') as fh:
        for st in out_studies:
            fh.write(json.dumps(dict(st, type='study'), ensure_ascii=False) + '\n')
        for it in items:
            fh.write(json.dumps(dict(it, type='item'), ensure_ascii=False) + '\n')

    with open(a.crosswalk, 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['case', 'folder', 'reception_id', 'reception_date', 'verdict'])
        for s in sorted(studies, key=lambda s: s.get('case', '')):
            if 'verdict' in s:
                w.writerow([s['case'], s['folder'], s['rid'], s['date'], s['verdict']])

    nimg = sum(len(f) for _, _, f in os.walk(img_dir))
    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(img_dir) for f in fs)
    print('\nstudies by verdict: %s' % dict(
        collections.Counter(s['verdict'] for s in studies if 'verdict' in s)))
    print('items: %s   total %d   (%d duplicate frames collapsed)'
          % (dict(counts), len(items), n_dupes))
    print('control weight: %d quiet frames, %d reviewed -> weight %.1f'
          % (n_quiet_total, n_quiet_taken,
             n_quiet_total / float(n_quiet_taken or 1)))
    print('overlap set: %d items' % sum(it['in_overlap'] for it in items))
    print('studies written: %d' % len(out_studies))
    print('images: %d files, %.1f MB' % (nimg, size / 1e6))
    print('\npool      -> %s' % out_path)
    print('crosswalk -> %s   (KEEP LOCAL -- do not upload)' % a.crosswalk)


if __name__ == '__main__':
    main()
