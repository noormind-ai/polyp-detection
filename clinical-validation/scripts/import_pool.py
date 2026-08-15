"""Load pool.jsonl into the panel database. Idempotent.

    python scripts/import_pool.py --pool data/pool.jsonl

Re-running with a rebuilt pool updates what changed and deactivates what
disappeared, rather than deleting it: an item someone has already reviewed must
stay resolvable, or the annotations pointing at it become orphans and the export
loses the provenance that makes it defensible as training data.
"""
import argparse, json, os, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'app'))
import db


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pool', required=True)
    a = ap.parse_args()

    db.init()
    con = db.connect()
    try:
        seen, n_items, n_studies = set(), 0, 0
        con.execute('BEGIN')
        with open(a.pool, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)

                if r.get('type') == 'study':
                    con.execute(
                        'INSERT INTO studies (case_label, model_verdict,'
                        ' report_polyp, report_scrubbed, finding, polyp_max_mm,'
                        ' polyp_morphology, polyp_location, frames, n_frames,'
                        ' created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
                        ' ON CONFLICT(case_label) DO UPDATE SET'
                        ' model_verdict=excluded.model_verdict,'
                        ' report_polyp=excluded.report_polyp,'
                        ' report_scrubbed=excluded.report_scrubbed,'
                        ' finding=excluded.finding,'
                        ' polyp_max_mm=excluded.polyp_max_mm,'
                        ' polyp_morphology=excluded.polyp_morphology,'
                        ' polyp_location=excluded.polyp_location,'
                        ' frames=excluded.frames, n_frames=excluded.n_frames',
                        (r['case'], r.get('verdict'), r.get('report_polyp'),
                         r.get('report_scrubbed') or '', r.get('finding') or '',
                         r.get('polyp_max_mm') or '', r.get('polyp_morphology') or '',
                         r.get('polyp_location') or '',
                         json.dumps(r['frames'], ensure_ascii=False),
                         r['n_frames'], time.time()))
                    n_studies += 1
                    continue

                seen.add(r['id'])
                con.execute(
                    'INSERT INTO items (id, bucket, case_label, frame_index,'
                    ' image, w, h, ai_conf, ai_boxes, sampling_weight,'
                    ' in_overlap, is_active, created_at)'
                    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)'
                    ' ON CONFLICT(id) DO UPDATE SET'
                    ' bucket=excluded.bucket, case_label=excluded.case_label,'
                    ' frame_index=excluded.frame_index, image=excluded.image,'
                    ' w=excluded.w, h=excluded.h, ai_conf=excluded.ai_conf,'
                    ' ai_boxes=excluded.ai_boxes,'
                    ' sampling_weight=excluded.sampling_weight,'
                    ' in_overlap=excluded.in_overlap, is_active=1',
                    (r['id'], r['bucket'], r['case'], r['frame_index'],
                     r['image'], r.get('w'), r.get('h'), r.get('ai_conf'),
                     json.dumps(r.get('ai_boxes') or []),
                     r.get('sampling_weight', 1.0), r.get('in_overlap', 0),
                     time.time()))
                n_items += 1

        gone = [x['id'] for x in con.execute(
            'SELECT id FROM items WHERE is_active=1').fetchall()
            if x['id'] not in seen]
        for iid in gone:
            con.execute('UPDATE items SET is_active=0 WHERE id=?', (iid,))
        con.execute('COMMIT')

        by = {x['bucket']: x['n'] for x in con.execute(
            'SELECT bucket, COUNT(*) n FROM items WHERE is_active=1'
            ' GROUP BY bucket').fetchall()}
        ov = con.execute('SELECT COUNT(*) n FROM items'
                         ' WHERE is_active=1 AND in_overlap=1').fetchone()['n']
        print('studies %d, items %d, deactivated %d' % (n_studies, n_items, len(gone)))
        print('active pool: %s  (total %d, overlap %d)'
              % (by, sum(by.values()), ov))
    finally:
        con.close()


if __name__ == '__main__':
    main()
