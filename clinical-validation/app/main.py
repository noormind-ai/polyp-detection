"""Offline clinical feedback panel — API and app.

Readers are shown de-identified colonoscopy stills and asked one question at a
time. What they are shown, and in what order, is decided here rather than in the
browser, because the whole value of the exercise depends on the reader not
knowing which kind of case they are looking at.

THE BLINDING RULE
-----------------
An item's payload carries the image and nothing else. The model's boxes and
confidence, the report text, and the bucket the item came from are never sent
to the browser before the reader's answer is recorded -- not hidden with CSS,
not sent and ignored. Anything delivered to the page is readable in developer
tools, and a reader who learns that "the ones with a report attached are the
ones the AI flagged" is no longer giving an independent opinion.

The model's box is never revealed at all. For a false-positive candidate the
question that matters is "is there a lesion here", and pointing at the model's
box first is exactly the anchor that would stop the answer meaning anything.
Whether the reader found the same thing the model did is settled afterwards, by
comparing their box to the model's -- which is why the box is worth asking for.

TWO PHASES, AND NOTHING IN BETWEEN
----------------------------------
Labelling runs uninterrupted. One image, one question, next image. No report, no
other images of that patient, no acknowledgement of whether the answer matched
anything -- an interruption after each image both slows the reader to a crawl
and starts teaching them what the model does.

The report and the rest of the patient's images appear exactly once per patient,
after every one of that patient's pooled images already has its own independent
answer. Which question is asked then depends on what the reader said:

  found something          the report and the whole patient, and: do you stand
                           by it? Asked identically whether the report records a
                           polyp or not, so the step gives nothing away.
  found nothing, and the   why? "Never captured in a still" is a legitimate
  report describes one     answer, and the one that stops a study being counted
                           as a model failure when the lesion was never
                           photographed at all.
  found nothing, and the   nothing to ask.
  report records none

ONE IMAGE AT A TIME
-------------------
There is no grid to pick from. Choosing the polyp out of a sheet of a patient's
images is an easier and different judgement from the one the model faces -- it
allows comparison between images, and it yields no negative label for the frames
the reader skipped past. Every frame is asked independently, including all of
them in a study the model missed, so a reader can say no to a whole study and be
right.

WHAT THE READER GETS BACK
-------------------------
Once an answer is recorded, and never before it, the reader is told which group
the image came from and what their answer is worth -- see EXPLAIN below for what
that costs and why it is logged. At the end of a patient, what the model had
flagged. At the end of a session, their own totals, pace, and how much of the
pool now carries a label.

What is never shown is a score. "You were right" is the one thing that would
teach a reader to predict the model instead of reading the image.

WHAT A SESSION CONTAINS
-----------------------
Each group's share of a session equals its share of the pool -- see session_mix
for why that is the only ratio at which all four finish together -- with part of
it drawn from a designed overlap set so agreement between readers is measurable.
The reader chooses only how many images. Time on each image is recorded, as is
its position in the session, so fatigue and rushing are visible in the data
rather than assumed away. The realised composition is stored per session, since
these proportions are nothing like true prevalence and any later estimate has to
correct for that.
"""
import hashlib, json, os, random, secrets, time

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

import db
import security as sec

def short_id(text):
    """Stable id in the same shape build_pool.py mints."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


APP_ROOT = '/review'
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

ALL_BUCKETS = ('fp', 'fn', 'tp', 'tn')


def session_mix(con):
    """Share of a session drawn from each group = that group's share of the pool.

    Not a tuning knob. Any mix other than the pool's own proportions leaves one
    group exhausted while another is still half-labelled: a group holding X% of
    the pool but given Y% of every session finishes after X/Y of a full pass,
    so the four only finish together when X == Y.

    How many of each are IN the pool is where the real decision was made, and it
    was made per group, on what each is for (see build_pool.py):

      fp  all of them  -- every false-positive candidate has to be adjudicated;
                          a "no" is a hard negative, a "yes" is a lesion the
                          report never recorded.
      fn  all of them  -- whether the lesion was ever photographed can only be
                          settled frame by frame.
      tp  all of them  -- only 169 exist, and they are what tests whether the
                          model fired on the RIGHT image. They also carry the
                          session's yes-rate: without them roughly one image in
                          ten is a polyp and "no" becomes a reflex; with them it
                          is about one in five.
      tn  a sample     -- 154 of 4302. A bias control, not a finding. Every one
                          carries the inverse sampling fraction so rates still
                          describe the archive rather than the sample.
    """
    rows = con.execute(
        'SELECT bucket, COUNT(*) n FROM items WHERE is_active=1 AND ad_hoc=0'
        ' GROUP BY bucket'
    ).fetchall()
    counts = {r['bucket']: r['n'] for r in rows}
    total = sum(counts.values())
    if not total:
        return {b: 0.0 for b in ALL_BUCKETS}
    return {b: counts.get(b, 0) / total for b in ALL_BUCKETS}

# Share of each session drawn from the designed overlap set, so that inter-reader
# agreement is measured on common items instead of accidental collisions.
OVERLAP_SHARE = 0.15

# The deployed model's per-frame operating point. Used only to tell the reader,
# at the patient review, which images the model had flagged -- never before they
# have answered.
OP_CONF = 0.70

# After an answer is recorded, tell the reader which group the image came from
# and what their answer is worth. Set CV_EXPLAIN=0 to switch it off.
#
# The cost, stated plainly: over a session this teaches the reader the base
# rates -- how often the model fires on nothing, how sparse the polyps are in a
# missed study -- and that can shift where they set their own threshold. It does
# NOT let them predict the next image, because nothing about the model's output
# or the report is visible in the image itself. Every annotation records whether
# the explanation was shown, so the drift can be measured instead of assumed
# absent.
EXPLAIN = os.environ.get('CV_EXPLAIN', '1') != '0'

# Keyed on the group and what the reader said. Rendered client-side so both
# languages read naturally; the server only decides which one applies.
EXPLAIN_KEYS = {
    ('fp', 'polyp'):    'why_fp_yes',
    ('fp', 'no_polyp'): 'why_fp_no',
    ('fp', 'unsure'):   'why_fp_unsure',
    ('fn', 'polyp'):    'why_fn_yes',
    ('fn', 'no_polyp'): 'why_fn_no',
    ('fn', 'unsure'):   'why_fn_unsure',
    ('tp', 'polyp'):    'why_tp_yes',
    ('tp', 'no_polyp'): 'why_tp_no',
    ('tp', 'unsure'):   'why_tp_unsure',
    ('tn', 'polyp'):    'why_tn_yes',
    ('tn', 'no_polyp'): 'why_tn_no',
    ('tn', 'unsure'):   'why_tn_unsure',
}

app = FastAPI(title='NoorMind clinical feedback panel', docs_url=None,
              redoc_url=None, openapi_url=None)


@app.on_event('startup')
def _startup():
    db.init()


# --------------------------------------------------------------------- deps
def get_con():
    con = db.connect()
    try:
        yield con
    finally:
        con.close()


def require_user(request: Request, con=Depends(get_con)):
    row = sec.current_session(con, request)
    if not row:
        raise HTTPException(status_code=401, detail='auth required')
    sec.check_csrf(request, row)
    return row


def require_ready(user=Depends(require_user)):
    """A user who has not yet replaced the issued password sees nothing."""
    if user['must_change_pw']:
        raise HTTPException(status_code=403, detail='password change required')
    return user


def require_admin(user=Depends(require_ready)):
    if user['role'] != 'admin':
        raise HTTPException(status_code=403, detail='admin only')
    return user


@app.middleware('http')
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['X-Frame-Options'] = 'DENY'
    resp.headers['Referrer-Policy'] = 'no-referrer'
    resp.headers['Cross-Origin-Opener-Policy'] = 'same-origin'
    resp.headers.setdefault('Cache-Control', 'no-store')
    # Self-contained page: no external origin is needed for anything, so none
    # is allowed. 'unsafe-inline' covers the single inline stylesheet.
    resp.headers['Content-Security-Policy'] = (
        "default-src 'none'; img-src 'self' data:; style-src 'self' "
        "'unsafe-inline'; script-src 'self'; font-src 'self'; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'")
    return resp


# --------------------------------------------------------------------- auth
class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=200)
    totp: str | None = Field(default=None, max_length=10)


BAD_LOGIN = 'Incorrect username or password.'


@app.post(APP_ROOT + '/api/login')
def login(body: LoginIn, request: Request, response: Response, con=Depends(get_con)):
    ip = sec.client_ip(request)
    if sec.ip_throttled(ip):
        raise HTTPException(status_code=429, detail='Too many attempts. Wait, then retry.')

    u = con.execute('SELECT * FROM users WHERE username = ?',
                    (body.username.strip(),)).fetchone()
    now = time.time()

    def fail(reason):
        sec.note_ip_failure(ip)
        if u:
            n = u['failed_count'] + 1
            con.execute('UPDATE users SET failed_count=?, locked_until=? WHERE id=?',
                        (n, now + sec.lock_seconds(n) if n >= sec.MAX_FAILS else None,
                         u['id']))
        db.audit(con, u['id'] if u else None, 'login_failed',
                 body.username.strip()[:64], ip, reason)
        # One message for every cause, so this cannot enumerate accounts.
        raise HTTPException(status_code=401, detail=BAD_LOGIN)

    if not u or not u['is_active']:
        fail('unknown or disabled')
    if u['locked_until'] and now < u['locked_until']:
        db.audit(con, u['id'], 'login_locked', u['username'], ip, None)
        raise HTTPException(status_code=401, detail=BAD_LOGIN)
    if not sec.verify_pw(u['pw_hash'], body.password):
        fail('bad password')
    if u['totp_enabled']:
        import pyotp
        if not body.totp or not pyotp.TOTP(u['totp_secret']).verify(
                body.totp.strip(), valid_window=1):
            fail('bad totp')

    if sec.needs_rehash(u['pw_hash']):
        con.execute('UPDATE users SET pw_hash=? WHERE id=?',
                    (sec.hash_pw(body.password), u['id']))
    con.execute('UPDATE users SET failed_count=0, locked_until=NULL,'
                ' last_login_at=? WHERE id=?', (now, u['id']))
    tok, csrf = sec.start_session(con, u['id'], ip, request.headers.get('user-agent'))
    db.audit(con, u['id'], 'login', None, ip, None)
    sec.set_cookie(response, tok, sec.secure_cookies())
    return {'username': u['username'], 'display_name': u['display_name'],
            'role': u['role'], 'must_change_pw': bool(u['must_change_pw']),
            'csrf': csrf}


@app.post(APP_ROOT + '/api/logout')
def logout(request: Request, response: Response, con=Depends(get_con)):
    row = sec.current_session(con, request)
    if row:
        sec.revoke(con, row['id'])
        db.audit(con, row['user_id'], 'logout', None, sec.client_ip(request), None)
    sec.clear_cookie(response, sec.secure_cookies())
    return {'ok': True}


@app.get(APP_ROOT + '/api/me')
def me(request: Request, con=Depends(get_con)):
    row = sec.current_session(con, request)
    if not row:
        raise HTTPException(status_code=401, detail='auth required')
    return {'username': row['username'], 'display_name': row['display_name'],
            'role': row['role'], 'must_change_pw': bool(row['must_change_pw']),
            'csrf': row['csrf']}


class ChangePwIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


@app.post(APP_ROOT + '/api/change-password')
def change_password(body: ChangePwIn, request: Request, user=Depends(require_user),
                    con=Depends(get_con)):
    u = con.execute('SELECT * FROM users WHERE id=?', (user['user_id'],)).fetchone()
    if not sec.verify_pw(u['pw_hash'], body.current):
        raise HTTPException(status_code=400, detail='Current password is incorrect.')
    if body.new == body.current:
        raise HTTPException(status_code=400, detail='Choose a different password.')
    problem = sec.password_problem(body.new, u['username'])
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    now = time.time()
    con.execute('UPDATE users SET pw_hash=?, must_change_pw=0, pw_changed_at=?'
                ' WHERE id=?', (sec.hash_pw(body.new), now, u['id']))
    # Every other session for this account dies with the old password.
    sec.revoke_all_for_user(con, u['id'])
    tok, csrf = sec.start_session(con, u['id'], sec.client_ip(request),
                                  request.headers.get('user-agent'))
    db.audit(con, u['id'], 'password_changed', None, sec.client_ip(request), None)
    resp = JSONResponse({'ok': True, 'csrf': csrf})
    sec.set_cookie(resp, tok, sec.secure_cookies())
    return resp


# ------------------------------------------------------------------ reading
class StartIn(BaseModel):
    n: int = Field(ge=5, le=300)


def _pick(con, bucket, want, user_id, taken, overlap_share):
    """Items of one bucket this reader has not answered.

    Two competing goals, so the quota is split rather than fudged:

      coverage  -- least-reviewed items first, so first opinions spread across
                   the pool as fast as possible.
      agreement -- a designed overlap set every reader is steered onto, so
                   inter-reader agreement sits on a common subset instead of on
                   whatever two readers happened to collide over.

    Random within ties, and the reader cannot tell the two apart, so neither
    choice biases an individual answer.
    """
    if want <= 0:
        return []
    rows = con.execute(
        'SELECT i.id, i.in_overlap, i.case_label,'
        '       (SELECT COUNT(*) FROM annotations a'
        "         WHERE a.item_id = i.id AND a.stage = 'blind' AND a.superseded = 0) AS n_all,"
        '       (SELECT COUNT(*) FROM annotations a'
        '         WHERE a.item_id = i.id AND a.user_id = ?) AS n_mine,'
        '       (SELECT COUNT(*) FROM annotations a JOIN items j'
        '          ON j.id = a.item_id WHERE a.user_id = ?'
        "          AND a.stage = 'blind' AND a.superseded = 0 AND j.case_label = i.case_label)"
        '         AS case_started'
        '  FROM items i WHERE i.bucket = ? AND i.is_active = 1'
        '   AND i.ad_hoc = 0',
        (user_id, user_id, bucket)).fetchall()
    free = [r for r in rows if r['n_mine'] == 0 and r['id'] not in taken]
    rnd = random.Random(secrets.randbits(32))
    rnd.shuffle(free)

    # Patients the reader has already started come first. The patient review
    # only fires once every one of a patient's images has an answer, so
    # scattering evenly would mean patients almost never complete and the
    # reader would rarely see the one screen that closes the loop.
    def order(r):
        return (0 if r['case_started'] else 1, r['n_all'])

    n_over = int(round(want * overlap_share))
    over = sorted([r for r in free if r['in_overlap']], key=order)
    chosen = [r['id'] for r in over[:n_over]]
    picked = set(chosen)
    rest = sorted([r for r in free if r['id'] not in picked], key=order)
    chosen += [r['id'] for r in rest[:want - len(chosen)]]
    return chosen


@app.post(APP_ROOT + '/api/session')
def start_session_(body: StartIn, request: Request, user=Depends(require_ready),
                   con=Depends(get_con)):
    uid = user['user_id']
    con.execute("UPDATE sessions SET status='abandoned', finished_at=?"
                " WHERE user_id=? AND status='active'", (time.time(), uid))

    n = body.n
    mix = session_mix(con)
    chosen, taken = [], set()
    for bucket in ALL_BUCKETS:
        got = _pick(con, bucket, int(round(n * mix[bucket])), uid,
                    taken, OVERLAP_SHARE)
        taken.update(got)
        chosen += got

    # Top up from whatever still has stock, in priority order, rather than
    # handing back a session shorter than the reader asked for.
    for bucket in ('fp', 'fn', 'tn', 'tp'):
        if len(chosen) >= n:
            break
        got = _pick(con, bucket, n - len(chosen), uid, taken, OVERLAP_SHARE)
        taken.update(got)
        chosen += got

    if not chosen:
        raise HTTPException(status_code=409,
                            detail='Nothing left to review. Every image has '
                                   'already been reviewed by this account.')

    # Shuffle before trimming so the cut falls across all groups, and so the
    # order carries no information about which group an image came from.
    random.shuffle(chosen)
    chosen = chosen[:n]

    sid = secrets.token_hex(12)
    realised = {}
    for iid in chosen:
        b = con.execute('SELECT bucket FROM items WHERE id=?',
                        (iid,)).fetchone()['bucket']
        realised[b] = realised.get(b, 0) + 1
    con.execute('INSERT INTO sessions (id, user_id, requested_n, mix, status,'
                ' started_at) VALUES (?,?,?,?,?,?)',
                (sid, uid, n, json.dumps(realised), 'active', time.time()))
    con.executemany('INSERT INTO worklist (session_id, task, item_id, position)'
                    " VALUES (?,'frame',?,?)",
                    [(sid, iid, i) for i, iid in enumerate(chosen)])
    db.audit(con, uid, 'session_start', sid, sec.client_ip(request),
             json.dumps(realised))
    return {'session': sid, 'total': len(chosen)}


@app.get(APP_ROOT + '/api/session/{sid}/summary')
def session_summary(sid: str, user=Depends(require_ready), con=Depends(get_con)):
    """What the reader gets back at the end of a session.

    Everything here is either their own answers, which they already know, or a
    pool-wide total that says nothing about any single image. Deliberately
    absent: how often they agreed with the model or the report, and anything
    resembling a score. That would be the most motivating thing to show and the
    one thing that cannot be shown -- a reader who learns how they are doing
    learns what the model does, and stops being an independent opinion. The
    comparison is real and worth having; it just belongs in the export, after
    the reading is finished, not in front of the reader mid-study.
    """
    s = _own_session(con, sid, user['user_id'])
    uid = user['user_id']

    mine = con.execute(
        "SELECT verdict, COUNT(*) n, SUM(CASE WHEN boxes NOT IN ('','[]')"
        '  THEN 1 ELSE 0 END) boxed, SUM(COALESCE(ms_on_item, 0)) ms'
        " FROM annotations WHERE session_id=? AND user_id=? AND stage='blind' AND superseded=0"
        ' GROUP BY verdict', (sid, uid)).fetchall()
    counts = {r['verdict']: r['n'] for r in mine}
    reviewed = sum(counts.values())
    boxes = sum(r['boxed'] or 0 for r in mine)
    seconds = sum(r['ms'] or 0 for r in mine) / 1000.0

    times = [r['ms_on_item'] for r in con.execute(
        "SELECT ms_on_item FROM annotations WHERE session_id=? AND user_id=?"
        " AND stage='blind' AND superseded=0 AND ms_on_item IS NOT NULL", (sid, uid)).fetchall()]
    times.sort()
    median_s = (times[len(times) // 2] / 1000.0) if times else 0

    confirmed = con.execute(
        "SELECT COUNT(*) c FROM annotations WHERE session_id=? AND user_id=?"
        " AND stage='confirm'", (sid, uid)).fetchone()['c']
    debriefs = con.execute(
        "SELECT COUNT(*) c FROM annotations WHERE session_id=? AND user_id=?"
        " AND stage='debrief' AND superseded=0", (sid, uid)).fetchone()['c']

    # Images this reader labelled that nobody had labelled before. A real thing
    # to be told, and it says nothing about what is in any of them.
    first = con.execute(
        'SELECT COUNT(*) c FROM annotations a WHERE a.session_id=? AND'
        " a.user_id=? AND a.stage='blind' AND a.superseded=0 AND NOT EXISTS ("
        '  SELECT 1 FROM annotations b WHERE b.item_id = a.item_id'
        "   AND b.stage='blind' AND b.superseded=0 AND b.user_id != a.user_id"
        '   AND b.created_at < a.created_at)', (sid, uid)).fetchone()['c']

    lifetime = con.execute(
        "SELECT COUNT(*) c FROM annotations WHERE user_id=? AND stage='blind' AND superseded=0",
        (uid,)).fetchone()['c']
    sessions_done = con.execute(
        "SELECT COUNT(*) c FROM sessions WHERE user_id=? AND status='done'",
        (uid,)).fetchone()['c']

    pool_total = con.execute(
        'SELECT COUNT(*) c FROM items WHERE is_active=1').fetchone()['c']
    pool_done = con.execute(
        'SELECT COUNT(DISTINCT a.item_id) c FROM annotations a JOIN items i'
        " ON i.id=a.item_id WHERE a.stage='blind' AND a.superseded=0 AND i.is_active=1"
    ).fetchone()['c']

    return {'reviewed': reviewed,
            'polyp': counts.get('polyp', 0),
            'normal': counts.get('no_polyp', 0),
            'unsure': counts.get('unsure', 0),
            'boxes': boxes, 'confirmed': confirmed, 'debriefs': debriefs,
            'seconds': round(seconds), 'median_s': round(median_s, 1),
            'first_labelled': first, 'lifetime': lifetime,
            'sessions_done': sessions_done,
            'pool_total': pool_total, 'pool_done': pool_done}


@app.get(APP_ROOT + '/api/session/current')
def current_session_(user=Depends(require_ready), con=Depends(get_con)):
    s = con.execute("SELECT * FROM sessions WHERE user_id=? AND status='active'"
                    ' ORDER BY started_at DESC LIMIT 1',
                    (user['user_id'],)).fetchone()
    if not s:
        return {'session': None}
    done = con.execute("SELECT COUNT(*) c FROM worklist WHERE session_id=?"
                       " AND status='done'", (s['id'],)).fetchone()['c']
    total = con.execute('SELECT COUNT(*) c FROM worklist WHERE session_id=?',
                        (s['id'],)).fetchone()['c']
    return {'session': s['id'], 'done': done, 'total': total}


def _own_session(con, sid, uid):
    s = con.execute('SELECT * FROM sessions WHERE id=? AND user_id=?',
                    (sid, uid)).fetchone()
    if not s:
        raise HTTPException(status_code=404, detail='no such session')
    return s


def _study_frame_urls(wid, frames):
    return [{'url': APP_ROOT + '/api/img/%d/%d' % (wid, i),
             'w': f['w'], 'h': f['h']} for i, f in enumerate(frames)]


@app.get(APP_ROOT + '/api/session/{sid}/next')
def next_item(sid: str, request: Request, user=Depends(require_ready),
              con=Depends(get_con)):
    """The next unanswered task.

    A frame task carries the image and nothing else -- no group, no confidence,
    no boxes, no report. See the blinding rule at the top of this module.
    """
    _own_session(con, sid, user['user_id'])
    w = con.execute("SELECT * FROM worklist WHERE session_id=? AND status='pending'"
                    ' ORDER BY position LIMIT 1', (sid,)).fetchone()
    total = con.execute('SELECT COUNT(*) c FROM worklist WHERE session_id=?',
                        (sid,)).fetchone()['c']
    done = con.execute("SELECT COUNT(*) c FROM worklist WHERE session_id=?"
                       " AND status='done'", (sid,)).fetchone()['c']
    if not w:
        con.execute("UPDATE sessions SET status='done', finished_at=? WHERE id=?",
                    (time.time(), sid))
        db.audit(con, user['user_id'], 'session_done', sid,
                 sec.client_ip(request), None)
        return {'done': True, 'total': total, 'completed': done}

    con.execute('UPDATE worklist SET served_at=? WHERE id=?',
                (time.time(), w['id']))
    out = {'done': False, 'wid': w['id'], 'position': w['position'],
           'total': total, 'completed': done, 'task': w['task']}

    if w['task'] == 'frame':
        it = con.execute('SELECT * FROM items WHERE id=?',
                         (w['item_id'],)).fetchone()
        db.audit(con, user['user_id'], 'item_view', it['id'],
                 sec.client_ip(request), sid)
        out.update(case=it['case_label'],
                   image=APP_ROOT + '/api/img/%d/f' % w['id'],
                   w=it['w'], h=it['h'])
        return out

    # A patient review. Reached only once every pooled image of this patient
    # has its own answer, so showing the report and the rest of the images can
    # no longer influence any of them.
    st = con.execute('SELECT * FROM studies WHERE case_label=?',
                     (w['case_label'],)).fetchone()
    frames = json.loads(st['frames'])
    db.audit(con, user['user_id'], w['task'] + '_view', st['case_label'],
             sec.client_ip(request), sid)

    # Which frames this reader marked, so they can see their own work rather
    # than having to remember it across a session of a hundred images.
    marked = [r['frame_index'] for r in con.execute(
        'SELECT i.frame_index FROM annotations a JOIN items i ON i.id=a.item_id'
        " WHERE a.user_id=? AND i.case_label=? AND a.stage='blind' AND a.superseded=0"
        " AND a.verdict='polyp' ORDER BY i.frame_index",
        (user['user_id'], st['case_label'])).fetchall()]

    # What the model thought, revealed here and nowhere else. Every one of this
    # patient's images already has an answer, so this cannot influence them.
    # It is the one moment the reader gets to see what they were up against,
    # which is worth a lot for staying engaged across a thousand images -- and
    # it is still only ever the model's frame-level flag, never its box, so
    # there is no location to anchor on if this patient comes round again.
    urls = _study_frame_urls(w['id'], frames)
    for u, f in zip(urls, frames):
        u['ai'] = 1 if (f.get('ai_conf') or 0) >= OP_CONF else 0

    out.update(case=st['case_label'], frames=urls,
               ai_flagged=sum(u['ai'] for u in urls),
               marked=marked, report_polyp=st['report_polyp'],
               finding=st['finding'] or '', report=st['report_scrubbed'] or '',
               size_mm=st['polyp_max_mm'] or '',
               morphology=st['polyp_morphology'] or '',
               location=st['polyp_location'] or '')
    return out


@app.get(APP_ROOT + '/api/session/{sid}/at/{position}')
def item_at(sid: str, position: int, request: Request,
            user=Depends(require_ready), con=Depends(get_con)):
    """An image the reader has already answered, so they can look again.

    Carries their current answer and, because the answer is already stored, the
    things that are only fair game afterwards: why the image was in the study,
    and where the model put its box. Going back cannot un-see those, which is
    exactly why revising is worth allowing -- a reader who now understands the
    task better should be able to fix an early answer rather than leave a label
    they no longer believe.

    Only frame tasks. The end-of-patient screens are not navigable: they depend
    on the whole patient's answers, and re-opening one mid-revision would show
    a summary of a state that no longer holds.
    """
    _own_session(con, sid, user['user_id'])
    w = con.execute("SELECT * FROM worklist WHERE session_id=? AND position=?"
                    " AND task='frame'", (sid, position)).fetchone()
    if not w:
        raise HTTPException(status_code=404, detail='not found')
    it = con.execute('SELECT * FROM items WHERE id=?', (w['item_id'],)).fetchone()
    total = con.execute('SELECT COUNT(*) c FROM worklist WHERE session_id=?',
                        (sid,)).fetchone()['c']
    done = con.execute("SELECT COUNT(*) c FROM worklist WHERE session_id=?"
                       " AND status='done'", (sid,)).fetchone()['c']

    ann = con.execute(
        "SELECT * FROM annotations WHERE worklist_id=? AND stage='blind'"
        ' AND superseded=0 ORDER BY id DESC LIMIT 1', (w['id'],)).fetchone()

    out = {'done': False, 'wid': w['id'], 'position': w['position'],
           'total': total, 'completed': done, 'task': 'frame',
           'case': it['case_label'],
           'image': APP_ROOT + '/api/img/%d/f' % w['id'],
           'w': it['w'], 'h': it['h'], 'reviewing': True}

    if ann:
        try:
            out['my_boxes'] = json.loads(ann['boxes'] or '[]')
        except Exception:
            out['my_boxes'] = []
        out['my_verdict'] = ann['verdict']
        if EXPLAIN:
            out['why'] = EXPLAIN_KEYS.get((it['bucket'], ann['verdict']))
        try:
            out['ai_boxes'] = json.loads(it['ai_boxes'] or '[]')
        except Exception:
            out['ai_boxes'] = []
        out['ai_conf'] = it['ai_conf']
    return out


@app.get(APP_ROOT + '/api/patient/{wid}')
def patient_view(wid: int, request: Request, user=Depends(require_ready),
                 con=Depends(get_con)):
    """Everything about the patient behind an image the reader has answered.

    Opened on demand, not pushed. The report, every image of that patient, what
    the model flagged, and whatever the reader has already said about any of
    them -- so they can go looking, rather than only answering what they were
    asked.

    Anything labelled from here is open-book by definition: the report is on the
    screen. Those labels are recorded at stage='open' and never replace a blind
    one. Both are worth having, and they are not the same measurement.
    """
    w = con.execute(
        'SELECT w.*, s.user_id FROM worklist w JOIN sessions s'
        ' ON s.id = w.session_id WHERE w.id = ?', (wid,)).fetchone()
    if not w or w['user_id'] != user['user_id']:
        raise HTTPException(status_code=404, detail='not found')

    case, this_frame = w['case_label'], None
    if w['item_id']:
        it = con.execute('SELECT case_label, frame_index FROM items WHERE id=?',
                         (w['item_id'],)).fetchone()
        if it:
            case, this_frame = it['case_label'], it['frame_index']
    st = con.execute('SELECT * FROM studies WHERE case_label=?',
                     (case,)).fetchone()
    if not st:
        raise HTTPException(status_code=404, detail='not found')

    # Only an answered image may open this. Otherwise the report sits one click
    # away from an image still waiting for its blind answer.
    if w['task'] == 'frame':
        answered = con.execute(
            "SELECT 1 FROM annotations WHERE worklist_id=? AND stage='blind'"
            ' AND superseded=0', (wid,)).fetchone()
        if not answered:
            raise HTTPException(status_code=403,
                                detail='Answer this image first.')

    frames = json.loads(st['frames'])
    urls = _study_frame_urls(wid, frames)
    for u, f in zip(urls, frames):
        u['ai'] = 1 if (f.get('ai_conf') or 0) >= OP_CONF else 0

    # What this reader has already said about each image of this patient.
    mine = {}
    for r in con.execute(
            'SELECT i.frame_index, a.stage, a.verdict, a.boxes'
            ' FROM annotations a JOIN items i ON i.id = a.item_id'
            ' WHERE a.user_id=? AND i.case_label=? AND a.superseded=0'
            " AND a.stage IN ('blind','open') ORDER BY a.id",
            (user['user_id'], case)).fetchall():
        try:
            boxes = json.loads(r['boxes'] or '[]')
        except Exception:
            boxes = []
        mine[str(r['frame_index'])] = {'verdict': r['verdict'],
                                       'stage': r['stage'], 'boxes': boxes}

    db.audit(con, user['user_id'], 'patient_view', case,
             sec.client_ip(request), None)
    return {'case': case, 'this_frame': this_frame,
            'report': st['report_scrubbed'] or '',
            'report_polyp': st['report_polyp'],
            'finding': st['finding'] or '',
            'size_mm': st['polyp_max_mm'] or '',
            'morphology': st['polyp_morphology'] or '',
            'location': st['polyp_location'] or '',
            'frames': urls, 'mine': mine,
            'ai_flagged': sum(u['ai'] for u in urls)}


class OpenLabelIn(BaseModel):
    wid: int
    frame_index: int = Field(ge=0)
    verdict: str = Field(max_length=20)
    boxes: list[list[float]] | None = None
    ms: int | None = Field(default=None, ge=0)


@app.post(APP_ROOT + '/api/label-open')
def label_open(body: OpenLabelIn, user=Depends(require_ready),
               con=Depends(get_con)):
    """Label any image of the patient, from the patient view.

    Recorded at stage='open'. It does not touch the blind answer for that image
    if one exists -- "what they thought looking at the image alone" and "what
    they thought with the report in front of them" are two measurements, and the
    second cannot stand in for the first.

    An image the sampling never selected gets an item created for it, flagged
    ad_hoc: never served as a blind question, never counted towards coverage or
    any rate. It was chosen because someone was looking at it, which is exactly
    what disqualifies it from a denominator. It is still good training data.
    """
    if body.verdict not in VERDICTS:
        raise HTTPException(status_code=400, detail='bad verdict')
    w = con.execute(
        'SELECT w.*, s.user_id, s.id AS sid FROM worklist w JOIN sessions s'
        ' ON s.id = w.session_id WHERE w.id = ?', (body.wid,)).fetchone()
    if not w or w['user_id'] != user['user_id']:
        raise HTTPException(status_code=404, detail='not found')

    case = w['case_label']
    if not case and w['item_id']:
        r = con.execute('SELECT case_label FROM items WHERE id=?',
                        (w['item_id'],)).fetchone()
        case = r['case_label'] if r else None
    st = con.execute('SELECT * FROM studies WHERE case_label=?',
                     (case,)).fetchone()
    if not st:
        raise HTTPException(status_code=404, detail='not found')
    frames = json.loads(st['frames'])
    if body.frame_index >= len(frames):
        raise HTTPException(status_code=404, detail='no such image')
    fr = frames[body.frame_index]

    item = con.execute(
        'SELECT * FROM items WHERE case_label=? AND frame_index=?',
        (case, body.frame_index)).fetchone()
    if not item:
        iid = short_id('adhoc' + case + fr['image'])
        con.execute(
            'INSERT INTO items (id, bucket, case_label, frame_index, image,'
            ' w, h, ai_conf, ai_boxes, sampling_weight, in_overlap, ad_hoc,'
            " is_active, created_at) VALUES (?,?,?,?,?,?,?,?,'[]',0,0,1,1,?)",
            (iid, 'fn' if st['report_polyp'] else 'tn', case, body.frame_index,
             fr['image'], fr.get('w'), fr.get('h'), fr.get('ai_conf'),
             time.time()))
        item = con.execute('SELECT * FROM items WHERE id=?', (iid,)).fetchone()

    prior = con.execute(
        "SELECT id FROM annotations WHERE user_id=? AND item_id=?"
        " AND stage='open' AND superseded=0 ORDER BY id DESC LIMIT 1",
        (user['user_id'], item['id'])).fetchone()
    if prior:
        con.execute('UPDATE annotations SET superseded=1 WHERE id=?',
                    (prior['id'],))

    con.execute(
        'INSERT INTO annotations (session_id, worklist_id, item_id, case_label,'
        ' user_id, stage, verdict, boxes, ai_shown, report_shown, ms_on_item,'
        ' created_at, revision_of) VALUES (?,?,?,?,?,?,?,?,1,1,?,?,?)',
        (w['sid'], None, item['id'], case, user['user_id'], 'open',
         body.verdict, json.dumps(body.boxes or []), body.ms, time.time(),
         prior['id'] if prior else None))
    return {'ok': True, 'ad_hoc': bool(item['ad_hoc'])}


class ReviseIn(BaseModel):
    wid: int
    verdict: str = Field(max_length=20)
    boxes: list[list[float]] | None = None
    ms: int | None = Field(default=None, ge=0)


@app.post(APP_ROOT + '/api/revise')
def revise(body: ReviseIn, user=Depends(require_ready), con=Depends(get_con)):
    """Replace an earlier answer. The old row stays, flagged superseded.

    Append-only is the point: a label whose history cannot be reconstructed is
    a label you cannot defend later. So a revision is a new row pointing back at
    the one it replaces, and the old one keeps its own timestamp and time-on-
    image rather than being overwritten.
    """
    if body.verdict not in VERDICTS:
        raise HTTPException(status_code=400, detail='bad verdict')
    w = con.execute(
        'SELECT w.*, s.user_id, s.id AS sid FROM worklist w JOIN sessions s'
        ' ON s.id = w.session_id WHERE w.id = ?', (body.wid,)).fetchone()
    if not w or w['user_id'] != user['user_id'] or w['task'] != 'frame':
        raise HTTPException(status_code=404, detail='not found')
    prior = con.execute(
        "SELECT * FROM annotations WHERE worklist_id=? AND stage='blind'"
        ' AND superseded=0 ORDER BY id DESC LIMIT 1', (w['id'],)).fetchone()
    if not prior:
        raise HTTPException(status_code=409, detail='nothing to revise')

    it = con.execute('SELECT * FROM items WHERE id=?', (w['item_id'],)).fetchone()
    con.execute('UPDATE annotations SET superseded=1 WHERE id=?', (prior['id'],))
    con.execute(
        'INSERT INTO annotations (session_id, worklist_id, item_id, case_label,'
        ' user_id, stage, verdict, boxes, position, ai_shown, report_shown,'
        ' ms_on_item, explained, created_at, revision_of)'
        ' VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?,?,?)',
        (w['sid'], w['id'], it['id'], it['case_label'], user['user_id'],
         'blind', body.verdict, json.dumps(body.boxes or []), w['position'],
         body.ms, 1 if EXPLAIN else 0, time.time(), prior['id']))

    # A patient-level confirmation that rested on the old answer no longer
    # does. Retire it rather than leave a "yes, I stand by it" attached to a
    # mark that has since been withdrawn.
    if prior['verdict'] == 'polyp' and body.verdict != 'polyp':
        con.execute("UPDATE annotations SET superseded=1 WHERE worklist_id=?"
                    " AND stage='confirm' AND superseded=0", (w['id'],))
        if w['status'] == 'awaiting_confirm':
            con.execute("UPDATE worklist SET status='done' WHERE id=?", (w['id'],))

    out = {'ok': True}
    if EXPLAIN:
        out['why'] = EXPLAIN_KEYS.get((it['bucket'], body.verdict))
    try:
        out['ai_boxes'] = json.loads(it['ai_boxes'] or '[]')
    except Exception:
        out['ai_boxes'] = []
    out['ai_conf'] = it['ai_conf']
    return out


@app.get(APP_ROOT + '/api/img/{wid}/{idx}')
def image(wid: int, idx: str, user=Depends(require_ready), con=Depends(get_con)):
    """Serve a frame, but only to the reader whose own worklist row asks for it.

    Images are never reachable as static files. idx='f' is the item's own frame;
    a number indexes into the study, which is what the escalation views need.
    """
    w = con.execute(
        'SELECT w.*, s.user_id FROM worklist w JOIN sessions s'
        ' ON s.id = w.session_id WHERE w.id = ?', (wid,)).fetchone()
    if not w or w['user_id'] != user['user_id']:
        raise HTTPException(status_code=404, detail='not found')

    rel = None
    if idx == 'f' and w['item_id']:
        r = con.execute('SELECT image FROM items WHERE id=?',
                        (w['item_id'],)).fetchone()
        rel = r['image'] if r else None
    else:
        case = w['case_label']
        if case is None and w['item_id']:
            r = con.execute('SELECT case_label FROM items WHERE id=?',
                            (w['item_id'],)).fetchone()
            case = r['case_label'] if r else None
        st = con.execute('SELECT frames FROM studies WHERE case_label=?',
                         (case,)).fetchone() if case else None
        if st:
            frames = json.loads(st['frames'])
            try:
                i = int(idx)
            except ValueError:
                i = -1
            if 0 <= i < len(frames):
                rel = frames[i]['image']
    if not rel:
        raise HTTPException(status_code=404, detail='not found')

    root = os.path.normpath(db.images_dir())
    path = os.path.normpath(os.path.join(root, rel))
    if not path.startswith(root) or not os.path.exists(path):
        raise HTTPException(status_code=404, detail='not found')
    return FileResponse(path, media_type='image/jpeg', headers={
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


class AnswerIn(BaseModel):
    wid: int
    verdict: str = Field(max_length=20)
    confidence: int | None = Field(default=None, ge=1, le=5)
    boxes: list[list[float]] | None = None
    note: str | None = Field(default=None, max_length=1000)
    ms: int | None = Field(default=None, ge=0)


VERDICTS = {'polyp', 'no_polyp', 'unsure'}


def _maybe_queue_case_review(con, sid, uid, case):
    """Queue the end-of-patient review, if this reader has now finished it.

    Only for patients whose report DOES describe a polyp. Those need the whole
    patient in view to answer either question:

      found something  ->  case_confirm: is what you marked the polyp the report
                           describes, or did you find something else?
      found nothing    ->  fn_debrief: why? "Never captured in a still" is a
                           legitimate answer and the one that keeps a study from
                           being counted as a model failure.

    Patients whose report records NO polyp are handled the moment the reader
    marks something -- see answer(). There the reader's finding is itself the
    news, and it is worth asking about while the image is still in front of
    them rather than a hundred images later.
    """
    total = con.execute('SELECT COUNT(*) c FROM items WHERE case_label=?'
                        ' AND is_active=1 AND ad_hoc=0', (case,)).fetchone()['c']
    mine = con.execute(
        'SELECT COUNT(DISTINCT a.item_id) c FROM annotations a'
        ' JOIN items i ON i.id = a.item_id'
        " WHERE a.user_id=? AND a.stage='blind' AND a.superseded=0 AND i.case_label=?",
        (uid, case)).fetchone()['c']
    if mine < total:
        return
    already = con.execute(
        'SELECT 1 FROM worklist w JOIN sessions s ON s.id = w.session_id'
        " WHERE s.user_id=? AND w.case_label=? AND w.task IN"
        " ('case_confirm','fn_debrief')", (uid, case)).fetchone()
    if already:
        return

    st = con.execute('SELECT report_polyp FROM studies WHERE case_label=?',
                     (case,)).fetchone()
    if not st or not st['report_polyp']:
        return          # clean patients are asked at the moment of the mark
    found = con.execute(
        'SELECT COUNT(*) c FROM annotations a JOIN items i ON i.id = a.item_id'
        " WHERE a.user_id=? AND i.case_label=? AND a.stage='blind' AND a.superseded=0"
        " AND a.verdict='polyp'", (uid, case)).fetchone()['c']
    task = 'case_confirm' if found else 'fn_debrief'

    pos = con.execute('SELECT COALESCE(MAX(position), -1) + 1 p FROM worklist'
                      ' WHERE session_id=?', (sid,)).fetchone()['p']
    con.execute('INSERT INTO worklist (session_id, task, case_label, position)'
                ' VALUES (?,?,?,?)', (sid, task, case, pos))


@app.post(APP_ROOT + '/api/answer')
def answer(body: AnswerIn, request: Request, user=Depends(require_ready),
           con=Depends(get_con)):
    """Record the answer, then say what the reader has earned the right to see.

    Nothing in this response could have reached the browser before the answer
    was stored, which is the whole of the blinding guarantee. After it, three
    things become fair game:

      why        which group the image came from and what the answer is worth.
      ai_boxes   where the model thought the lesion was, if it fired at all.
                 This is the anchor that had to be withheld until now, and the
                 single most interesting thing to hand back once it cannot
                 influence the answer.
      confirm    for a patient whose report records NO polyp, and where the
                 reader has just marked something: the report and the rest of
                 that patient's images, straight away. Their finding is the
                 news, and it is worth asking about while the image is still in
                 front of them rather than a hundred images later.

    Patients whose report does describe a polyp are asked at the end of the
    patient instead -- judging whether a mark is THE reported lesion needs the
    whole patient in view. See _maybe_queue_case_review().
    """
    if body.verdict not in VERDICTS:
        raise HTTPException(status_code=400, detail='bad verdict')
    w = con.execute(
        'SELECT w.*, s.user_id, s.id AS sid FROM worklist w JOIN sessions s'
        ' ON s.id = w.session_id WHERE w.id = ?', (body.wid,)).fetchone()
    if not w or w['user_id'] != user['user_id']:
        raise HTTPException(status_code=404, detail='not found')
    if w['status'] != 'pending' or w['task'] != 'frame':
        raise HTTPException(status_code=409, detail='already answered')
    it = con.execute('SELECT * FROM items WHERE id=?', (w['item_id'],)).fetchone()

    con.execute(
        'INSERT INTO annotations (session_id, worklist_id, item_id, case_label,'
        ' user_id, stage, verdict, confidence, boxes, position, ai_shown,'
        ' report_shown, note, ms_on_item, explained, created_at)'
        ' VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?)',
        (w['sid'], w['id'], it['id'], it['case_label'], user['user_id'],
         'blind', body.verdict, body.confidence, json.dumps(body.boxes or []),
         w['position'], body.note, body.ms, 1 if EXPLAIN else 0, time.time()))
    con.execute('UPDATE worklist SET status=? WHERE id=?', ('done', w['id']))
    _maybe_queue_case_review(con, w['sid'], user['user_id'], it['case_label'])

    out = {'next': 'item'}
    if EXPLAIN:
        out['why'] = EXPLAIN_KEYS.get((it['bucket'], body.verdict))
    # The model's boxes, now that they cannot anchor anything.
    try:
        out['ai_boxes'] = json.loads(it['ai_boxes'] or '[]')
    except Exception:
        out['ai_boxes'] = []
    out['ai_conf'] = it['ai_conf']

    st = con.execute('SELECT * FROM studies WHERE case_label=?',
                     (it['case_label'],)).fetchone()
    if body.verdict == 'polyp' and st and not st['report_polyp']:
        done_already = con.execute(
            "SELECT 1 FROM annotations WHERE user_id=? AND case_label=?"
            " AND stage='confirm'", (user['user_id'], it['case_label'])).fetchone()
        if not done_already:
            # Asked once per patient, not once per marked image: a reader who
            # marks three images of the same clean patient should not be shown
            # the same report three times.
            con.execute('UPDATE worklist SET status=? WHERE id=?',
                        ('awaiting_confirm', w['id']))
            frames = json.loads(st['frames'])
            urls = _study_frame_urls(w['id'], frames)
            for u, f in zip(urls, frames):
                u['ai'] = 1 if (f.get('ai_conf') or 0) >= OP_CONF else 0
            out['next'] = 'confirm'
            out['confirm'] = {
                'report': st['report_scrubbed'] or '',
                'report_polyp': 0,
                'frames': urls,
                'ai_flagged': sum(u['ai'] for u in urls),
                'this_frame': it['frame_index']}
    return out


class ConfirmIn(BaseModel):
    wid: int
    verdict: str = Field(max_length=20)      # confirm | retract | unsure
    note: str | None = Field(default=None, max_length=1000)
    ms: int | None = Field(default=None, ge=0)


@app.post(APP_ROOT + '/api/answer-confirm')
def answer_confirm(body: ConfirmIn, user=Depends(require_ready),
                   con=Depends(get_con)):
    """The patient-level verdict, recorded against the case, not one frame."""
    if body.verdict not in {'confirm', 'retract', 'unsure'}:
        raise HTTPException(status_code=400, detail='bad verdict')
    w = con.execute(
        'SELECT w.*, s.user_id, s.id AS sid FROM worklist w JOIN sessions s'
        ' ON s.id = w.session_id WHERE w.id = ?', (body.wid,)).fetchone()
    if not w or w['user_id'] != user['user_id']:
        raise HTTPException(status_code=404, detail='not found')
    # Two ways to arrive here, and both are a patient-level verdict:
    #   inline   the reader marked something in a patient whose report records
    #            no polyp, and was asked immediately (task='frame').
    #   deferred the end-of-patient review for a report-positive patient
    #            (task='case_confirm').
    inline = w['task'] == 'frame' and w['status'] == 'awaiting_confirm'
    deferred = w['task'] == 'case_confirm' and w['status'] == 'pending'
    if not (inline or deferred):
        raise HTTPException(status_code=409, detail='not a pending confirmation')

    case = w['case_label']
    if case is None and w['item_id']:
        r = con.execute('SELECT case_label FROM items WHERE id=?',
                        (w['item_id'],)).fetchone()
        case = r['case_label'] if r else None

    con.execute(
        'INSERT INTO annotations (session_id, worklist_id, case_label, user_id,'
        ' stage, verdict, position, ai_shown, report_shown, note, ms_on_item,'
        ' created_at) VALUES (?,?,?,?,?,?,?,1,1,?,?,?)',
        (w['sid'], w['id'], case, user['user_id'], 'confirm',
         body.verdict, w['position'], body.note, body.ms, time.time()))
    con.execute('UPDATE worklist SET status=? WHERE id=?', ('done', w['id']))
    if inline:
        _maybe_queue_case_review(con, w['sid'], user['user_id'], case)
    return {'next': 'item'}


class DebriefIn(BaseModel):
    wid: int
    reason: str = Field(max_length=40)
    frames: list[int] | None = None
    note: str | None = Field(default=None, max_length=2000)
    ms: int | None = Field(default=None, ge=0)


# Why a report-described polyp appears in none of the saved stills. These are
# the explanations that change what we do with the study: "not_captured" means
# the frames are correctly negative and the model was never given a chance,
# which is not a model failure at all and must not be counted as one.
DEBRIEF_REASONS = {'not_captured', 'now_visible', 'poor_quality',
                   'report_mismatch', 'other'}


@app.post(APP_ROOT + '/api/answer-debrief')
def answer_debrief(body: DebriefIn, user=Depends(require_ready),
                   con=Depends(get_con)):
    if body.reason not in DEBRIEF_REASONS:
        raise HTTPException(status_code=400, detail='bad reason')
    w = con.execute(
        'SELECT w.*, s.user_id, s.id AS sid FROM worklist w JOIN sessions s'
        ' ON s.id = w.session_id WHERE w.id = ?', (body.wid,)).fetchone()
    if not w or w['user_id'] != user['user_id']:
        raise HTTPException(status_code=404, detail='not found')
    if w['status'] != 'pending' or w['task'] != 'fn_debrief':
        raise HTTPException(status_code=409, detail='not a pending debrief')
    con.execute(
        'INSERT INTO annotations (session_id, worklist_id, case_label, user_id,'
        ' stage, verdict, reason, frames, position, ai_shown, report_shown,'
        ' note, ms_on_item, created_at) VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?,?)',
        (w['sid'], w['id'], w['case_label'], user['user_id'], 'debrief',
         body.reason, body.reason, json.dumps(body.frames or []),
         w['position'], body.note, body.ms, time.time()))
    con.execute('UPDATE worklist SET status=? WHERE id=?', ('done', w['id']))
    return {'next': 'item'}


# -------------------------------------------------------------------- admin
class NewUserIn(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r'^[A-Za-z0-9._-]+$')
    display_name: str = Field(default='', max_length=120)
    role: str = Field(default='reader', pattern='^(reader|admin)$')


@app.post(APP_ROOT + '/api/admin/users')
def create_user(body: NewUserIn, request: Request, admin=Depends(require_admin),
                con=Depends(get_con)):
    if con.execute('SELECT 1 FROM users WHERE username=?',
                   (body.username,)).fetchone():
        raise HTTPException(status_code=409, detail='That username is taken.')
    temp = sec.new_temp_password()
    con.execute(
        'INSERT INTO users (username, display_name, role, pw_hash,'
        ' must_change_pw, created_at, created_by) VALUES (?,?,?,?,1,?,?)',
        (body.username, body.display_name, body.role, sec.hash_pw(temp),
         time.time(), admin['user_id']))
    db.audit(con, admin['user_id'], 'user_created', body.username,
             sec.client_ip(request), body.role)
    # Shown exactly once. It is not stored anywhere in recoverable form.
    return {'username': body.username, 'temp_password': temp}


@app.get(APP_ROOT + '/api/admin/users')
def list_users(admin=Depends(require_admin), con=Depends(get_con)):
    rows = con.execute(
        'SELECT u.id, u.username, u.display_name, u.role, u.is_active,'
        '       u.must_change_pw, u.totp_enabled, u.last_login_at, u.created_at,'
        '       (SELECT COUNT(*) FROM annotations a WHERE a.user_id = u.id'
        "         AND a.stage = 'blind' AND a.superseded = 0) AS reviewed"
        ' FROM users u ORDER BY u.created_at').fetchall()
    return [dict(r) for r in rows]


class UserPatch(BaseModel):
    is_active: bool | None = None
    reset_password: bool | None = None


@app.post(APP_ROOT + '/api/admin/users/{uid}')
def patch_user(uid: int, body: UserPatch, request: Request,
               admin=Depends(require_admin), con=Depends(get_con)):
    u = con.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
    if not u:
        raise HTTPException(status_code=404, detail='no such user')
    out = {'ok': True}
    if body.is_active is not None:
        if uid == admin['user_id'] and not body.is_active:
            raise HTTPException(status_code=400,
                                detail='You cannot disable your own account.')
        con.execute('UPDATE users SET is_active=? WHERE id=?',
                    (1 if body.is_active else 0, uid))
        if not body.is_active:
            sec.revoke_all_for_user(con, uid)
        db.audit(con, admin['user_id'],
                 'user_enabled' if body.is_active else 'user_disabled',
                 u['username'], sec.client_ip(request), None)
    if body.reset_password:
        temp = sec.new_temp_password()
        con.execute('UPDATE users SET pw_hash=?, must_change_pw=1,'
                    ' failed_count=0, locked_until=NULL WHERE id=?',
                    (sec.hash_pw(temp), uid))
        sec.revoke_all_for_user(con, uid)
        db.audit(con, admin['user_id'], 'user_password_reset', u['username'],
                 sec.client_ip(request), None)
        out['temp_password'] = temp
    return out


@app.get(APP_ROOT + '/api/admin/stats')
def stats(admin=Depends(require_admin), con=Depends(get_con)):
    pool = {r['bucket']: r['n'] for r in con.execute(
        'SELECT bucket, COUNT(*) n FROM items WHERE is_active=1'
        ' GROUP BY bucket').fetchall()}
    reviewed = {r['bucket']: r['n'] for r in con.execute(
        'SELECT i.bucket, COUNT(DISTINCT a.item_id) n FROM annotations a'
        " JOIN items i ON i.id = a.item_id WHERE a.stage='blind' AND a.superseded=0"
        ' GROUP BY i.bucket').fetchall()}
    # What is left to cover, per bucket. The FP row is the one that matters:
    # every false-positive candidate has to be adjudicated by someone before
    # the hard-negative set is complete.
    remaining = {b: pool.get(b, 0) - reviewed.get(b, 0) for b in pool}

    # Confirmed false positives: the model fired, the report is clean, and a
    # reader looking at the frame blind saw nothing. These are the hard
    # negatives a fine-tune wants.
    confirmed_fp = con.execute(
        "SELECT COUNT(*) c FROM annotations a JOIN items i ON i.id=a.item_id"
        " WHERE a.stage='blind' AND a.superseded=0 AND i.bucket='fp' AND a.verdict='no_polyp'"
    ).fetchone()['c']
    # Candidate report misses: a reader marked a lesion in a patient whose
    # report records none, and stood by it once shown the report and the rest
    # of that patient's images. Keyed on the case, not on one frame -- the
    # confirmation is a patient-level verdict.
    missed = con.execute(
        "SELECT COUNT(*) c FROM annotations a"
        ' JOIN studies st ON st.case_label = a.case_label'
        " WHERE a.stage='confirm' AND a.superseded=0 AND a.verdict='confirm'"
        ' AND st.report_polyp = 0').fetchone()['c']
    # The mirror image: the reader marked something in a patient whose report
    # does describe a polyp, and confirmed it. That says the model fired on the
    # wrong frame or missed the right one, not that the patient was wrong.
    localised = con.execute(
        "SELECT COUNT(*) c FROM annotations a"
        ' JOIN studies st ON st.case_label = a.case_label'
        " WHERE a.stage='confirm' AND a.superseded=0 AND a.verdict='confirm'"
        ' AND st.report_polyp = 1').fetchone()['c']
    # Frames a reader marked in a study the model missed entirely: the positives
    # a fine-tune actually needs, each with a box.
    fn_found = con.execute(
        "SELECT COUNT(*) c FROM annotations a JOIN items i ON i.id=a.item_id"
        " WHERE a.stage='blind' AND a.superseded=0 AND i.bucket='fn' AND a.verdict='polyp'"
    ).fetchone()['c']
    # Why the missed studies were missed. 'not_captured' means the lesion is in
    # no saved still, so those frames are correctly negative and the study is
    # not evidence of a model failure at all.
    debriefs = {r['reason']: r['n'] for r in con.execute(
        "SELECT reason, COUNT(*) n FROM annotations WHERE stage='debrief' AND superseded=0"
        " GROUP BY reason").fetchall()}

    # Attention check. TP items are ones the report and the model agree on, so
    # a reader calling them "no polyp" is a signal about the reader, not the
    # image. Not proof of anything on its own -- a still from an agreed-positive
    # study need not show the polyp -- but a rate far off the others is worth
    # a look before the session's answers go into a training set.
    per_reader = con.execute(
        'SELECT u.id, u.username, u.display_name,'
        "  SUM(CASE WHEN a.stage='blind' AND a.superseded=0 THEN 1 ELSE 0 END) reviewed,"
        "  SUM(CASE WHEN i.bucket='tp' AND a.stage='blind' AND a.superseded=0 THEN 1 ELSE 0 END) tp_seen,"
        "  SUM(CASE WHEN i.bucket='tp' AND a.stage='blind' AND a.superseded=0"
        "      AND a.verdict='polyp' THEN 1 ELSE 0 END) tp_called,"
        "  SUM(CASE WHEN i.bucket='tn' AND a.stage='blind' AND a.superseded=0"
        "      AND a.verdict='polyp' THEN 1 ELSE 0 END) tn_called_polyp,"
        '  AVG(a.ms_on_item) avg_ms'
        ' FROM users u LEFT JOIN annotations a ON a.user_id = u.id'
        ' LEFT JOIN items i ON i.id = a.item_id'
        " WHERE u.role='reader' GROUP BY u.id ORDER BY reviewed DESC").fetchall()

    sessions = con.execute(
        'SELECT s.id, u.username, s.requested_n, s.mix, s.status, s.started_at,'
        '  (SELECT COUNT(*) FROM worklist w WHERE w.session_id=s.id'
        "    AND w.status!='pending') done,"
        '  (SELECT COUNT(*) FROM worklist w WHERE w.session_id=s.id) total'
        ' FROM sessions s JOIN users u ON u.id=s.user_id'
        ' ORDER BY s.started_at DESC LIMIT 40').fetchall()

    return {'pool': pool, 'reviewed': reviewed, 'remaining': remaining,
            'confirmed_fp': confirmed_fp, 'report_misses': missed,
            'fn_found': fn_found, 'debriefs': debriefs,
            'localised': localised,
            'readers': [dict(r) for r in per_reader],
            'sessions': [dict(r) for r in sessions]}


@app.get(APP_ROOT + '/api/admin/export')
def export(admin=Depends(require_admin), con=Depends(get_con)):
    """Every annotation with the item it belongs to, newline-delimited JSON.

    Includes the model's boxes and the bucket, which readers never saw, so the
    comparison between what the reader marked and what the model marked can be
    made offline. Case labels stay pseudonymous -- the crosswalk back to a real
    study never left the machine that built the pool.
    """
    rows = con.execute(
        'SELECT a.id, a.stage, a.verdict, a.reason, a.confidence, a.boxes,'
        '       a.frames, a.note, a.ms_on_item, a.position, a.created_at,'
        '       a.revision_of, a.session_id, u.username AS reader,'
        '       a.item_id, a.case_label,'
        '       i.bucket, i.frame_index, i.image, i.w, i.h, i.ai_conf,'
        '       i.ai_boxes, i.sampling_weight, i.in_overlap,'
        '       st.model_verdict, st.report_polyp, st.finding, st.n_frames,'
        '       st.polyp_max_mm, st.polyp_morphology, st.polyp_location'
        '  FROM annotations a JOIN users u ON u.id = a.user_id'
        '  LEFT JOIN items i ON i.id = a.item_id'
        '  LEFT JOIN studies st ON st.case_label = a.case_label'
        ' ORDER BY a.id').fetchall()

    def lines():
        for r in rows:
            d = dict(r)
            for k in ('boxes', 'frames', 'ai_boxes'):
                try:
                    d[k] = json.loads(d[k]) if d[k] else []
                except Exception:
                    d[k] = []
            yield json.dumps(d, ensure_ascii=False) + '\n'

    db.audit(con, admin['user_id'], 'export', None, None, '%d rows' % len(rows))
    return Response(''.join(lines()), media_type='application/x-ndjson',
                    headers={'Content-Disposition':
                             'attachment; filename="annotations.jsonl"'})


@app.get(APP_ROOT + '/api/admin/reader/{uid}')
def reader_detail(uid: int, limit: int = 300, admin=Depends(require_admin),
                  con=Depends(get_con)):
    """Everything one reader has said, newest first.

    Exists so a reader's work can be judged as a body rather than as a line in
    a summary: whether their yes-rate is plausible, whether they slowed down or
    sped up, whether the agreed positives went the way they should. If it does
    not hold up, retire_reader() takes the whole lot out of the data.
    """
    u = con.execute('SELECT id, username, display_name, role, is_active,'
                    ' created_at, last_login_at FROM users WHERE id=?',
                    (uid,)).fetchone()
    if not u:
        raise HTTPException(status_code=404, detail='no such user')

    summary = {r['k']: r['n'] for r in con.execute(
        "SELECT (a.stage || ':' || COALESCE(a.verdict,'-')) k, COUNT(*) n"
        ' FROM annotations a WHERE a.user_id=? AND a.superseded=0'
        ' GROUP BY k', (uid,)).fetchall()}
    by_bucket = {r['bucket']: {'n': r['n'], 'yes': r['yes']} for r in con.execute(
        "SELECT i.bucket, COUNT(*) n,"
        "  SUM(CASE WHEN a.verdict='polyp' THEN 1 ELSE 0 END) yes"
        ' FROM annotations a JOIN items i ON i.id=a.item_id'
        " WHERE a.user_id=? AND a.stage='blind' AND a.superseded=0"
        ' GROUP BY i.bucket', (uid,)).fetchall()}
    retired = con.execute(
        'SELECT COUNT(*) c FROM annotations WHERE user_id=? AND superseded=1',
        (uid,)).fetchone()['c']

    rows = con.execute(
        'SELECT a.id, a.stage, a.verdict, a.reason, a.note, a.boxes,'
        '       a.ms_on_item, a.position, a.created_at, a.superseded,'
        '       a.case_label, a.item_id, i.bucket, i.frame_index, i.ai_conf,'
        '       i.ad_hoc'
        ' FROM annotations a LEFT JOIN items i ON i.id = a.item_id'
        ' WHERE a.user_id=? ORDER BY a.id DESC LIMIT ?',
        (uid, max(1, min(limit, 2000)))).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d['boxes'] = json.loads(d['boxes'] or '[]')
        except Exception:
            d['boxes'] = []
        if d['item_id']:
            d['thumb'] = APP_ROOT + '/api/admin/img/' + d['item_id']
        out.append(d)

    return {'user': dict(u), 'summary': summary, 'by_bucket': by_bucket,
            'retired': retired, 'annotations': out}


@app.get(APP_ROOT + '/api/admin/img/{item_id}')
def admin_image(item_id: str, request: Request, admin=Depends(require_admin),
                con=Depends(get_con)):
    """An item's image, for an admin reviewing someone's work.

    Separate from the reader route on purpose: that one is scoped to the
    requester's own worklist, which is what keeps one reader from walking the
    archive. This one is admin-only and audited.
    """
    it = con.execute('SELECT image FROM items WHERE id=?', (item_id,)).fetchone()
    if not it:
        raise HTTPException(status_code=404, detail='not found')
    root = os.path.normpath(db.images_dir())
    path = os.path.normpath(os.path.join(root, it['image']))
    if not path.startswith(root) or not os.path.exists(path):
        raise HTTPException(status_code=404, detail='not found')
    db.audit(con, admin['user_id'], 'admin_image', item_id,
             sec.client_ip(request), None)
    return FileResponse(path, media_type='image/jpeg', headers={
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


class ReaderDataIn(BaseModel):
    action: str = Field(pattern='^(retire|restore)$')


@app.post(APP_ROOT + '/api/admin/users/{uid}/annotations')
def retire_reader(uid: int, body: ReaderDataIn, request: Request,
                  admin=Depends(require_admin), con=Depends(get_con)):
    """Take one reader's feedback out of the data, or put it back.

    Retiring flags every row superseded rather than deleting it: the same
    mechanism a revision uses, so the rows drop out of every count, every
    coverage figure and the default export, while still being there if the
    decision is reconsidered. Deleting would make the reason for the change
    unrecoverable, which is exactly what you want to keep in a study.
    """
    u = con.execute('SELECT username FROM users WHERE id=?', (uid,)).fetchone()
    if not u:
        raise HTTPException(status_code=404, detail='no such user')
    flag = 1 if body.action == 'retire' else 0
    cur = con.execute('UPDATE annotations SET superseded=? WHERE user_id=?'
                      ' AND superseded=?', (flag, uid, 1 - flag))
    n = cur.rowcount if cur.rowcount is not None else 0
    db.audit(con, admin['user_id'], 'reader_' + body.action, u['username'],
             sec.client_ip(request), '%d annotations' % n)
    return {'ok': True, 'affected': n}


@app.get(APP_ROOT + '/api/admin/audit')
def audit_log(limit: int = 200, admin=Depends(require_admin), con=Depends(get_con)):
    rows = con.execute(
        'SELECT a.ts, a.action, a.object, a.ip, a.detail, u.username'
        ' FROM audit a LEFT JOIN users u ON u.id = a.user_id'
        ' ORDER BY a.id DESC LIMIT ?', (max(1, min(limit, 1000)),)).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------- page
@app.get(APP_ROOT + '/health')
def health():
    return {'ok': True}


@app.get(APP_ROOT + '/app.js')
def appjs():
    return FileResponse(os.path.join(STATIC, 'app.js'),
                        media_type='application/javascript',
                        headers={'Cache-Control': 'no-store'})


@app.get(APP_ROOT + '/style.css')
def appcss():
    return FileResponse(os.path.join(STATIC, 'style.css'), media_type='text/css',
                        headers={'Cache-Control': 'no-store'})


@app.get(APP_ROOT, response_class=HTMLResponse)
@app.get(APP_ROOT + '/', response_class=HTMLResponse)
def index():
    with open(os.path.join(STATIC, 'index.html'), encoding='utf-8') as fh:
        return HTMLResponse(fh.read(), headers={'Cache-Control': 'no-store'})
