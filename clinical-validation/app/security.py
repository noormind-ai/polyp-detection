"""Authentication and access control.

The panel holds patient images, so the defaults here are deliberately strict:

  * Accounts exist only because an admin made them. There is no registration
    route and no password-reset-by-email path -- an admin issues a one-time
    password out of band and the account is forced to change it before it can
    reach a single image.
  * Argon2id for password storage.
  * The session cookie is a random token; only its SHA-256 is stored, so a
    stolen database backup does not yield usable sessions. Sessions expire on
    an idle timeout and again on an absolute one.
  * SameSite=Strict plus a double-submit CSRF token on every mutating request.
    Either alone would very likely do; both cost nothing.
  * Failed logins lock the account with exponential backoff, and are counted
    per source address as well, so one attacker cannot lock every account out
    by guessing at them in turn.

Login failures deliberately return one message for every cause -- unknown user,
wrong password, wrong TOTP, disabled account -- so the response cannot be used
to enumerate who has an account.
"""
import hashlib, hmac, os, re, secrets, time

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from fastapi import HTTPException, Request

from db import audit

COOKIE = 'cv_session'
COOKIE_PATH = '/review'
IDLE_TIMEOUT = 30 * 60          # seconds without a request before re-login
ABSOLUTE_TIMEOUT = 12 * 3600    # a session cannot outlive this, active or not
MAX_FAILS = 5
LOCK_BASE = 60                  # seconds; doubles per failure past MAX_FAILS
PW_MIN = 12

_ph = PasswordHasher()

# Per-address login throttle. In-process and therefore reset by a restart, which
# is acceptable: the per-account lockout in the database is the durable control,
# and this only exists to blunt spraying across many accounts.
_ip_fails: dict[str, list[float]] = {}
IP_WINDOW = 15 * 60
IP_MAX = 30


def hash_pw(pw: str) -> str:
    return _ph.hash(pw)


def verify_pw(stored: str, pw: str) -> bool:
    try:
        _ph.verify(stored, pw)
        return True
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    try:
        return _ph.check_needs_rehash(stored)
    except Exception:
        return False


# Rejected outright. Short lists like this are not a substitute for length, but
# they do stop the handful of passwords that get tried first.
_COMMON = {
    'password', 'password1', 'passw0rd', '123456', '12345678', '123456789',
    'qwerty', 'letmein', 'welcome', 'admin', 'administrator', 'noormind',
    'polyp', 'colonoscopy', 'changeme', 'iloveyou', 'abc123',
}


def password_problem(pw: str, username: str = '') -> str | None:
    """None if acceptable, else a reason to show the user."""
    if len(pw) < PW_MIN:
        return 'Password must be at least %d characters.' % PW_MIN
    if len(pw) > 200:
        return 'Password is too long.'
    low = pw.lower()
    if low in _COMMON:
        return 'That password is too common.'
    if username and username.lower() in low:
        return 'Password must not contain the username.'
    classes = sum(bool(re.search(p, pw)) for p in
                  (r'[a-z]', r'[A-Z]', r'\d', r'[^A-Za-z0-9]'))
    if classes < 3:
        return ('Use at least three of: lower case, upper case, digits, '
                'symbols.')
    return None


def new_temp_password() -> str:
    """A readable one-time password. Only ever shown once, at issue."""
    alphabet = 'abcdefghijkmnpqrstuvwxyz'
    digits = '23456789'
    upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    pick = [secrets.choice(upper), secrets.choice(digits), secrets.choice('!@#$%*?')]
    pick += [secrets.choice(alphabet) for _ in range(11)]
    secrets.SystemRandom().shuffle(pick)
    return ''.join(pick)


def token_hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def client_ip(request: Request) -> str:
    # nginx sets X-Real-IP; nothing else is trusted to.
    return (request.headers.get('x-real-ip')
            or (request.client.host if request.client else '?'))


def ip_throttled(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _ip_fails.get(ip, []) if now - t < IP_WINDOW]
    _ip_fails[ip] = hits
    return len(hits) >= IP_MAX


def note_ip_failure(ip: str) -> None:
    _ip_fails.setdefault(ip, []).append(time.time())


def lock_seconds(failed_count: int) -> int:
    over = max(0, failed_count - MAX_FAILS)
    return min(LOCK_BASE * (2 ** over), 3600)


def start_session(con, user_id: int, ip: str, ua: str) -> tuple[str, str]:
    """Returns (cookie value, csrf token)."""
    tok, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
    now = time.time()
    con.execute(
        'INSERT INTO auth_sessions (id, user_id, csrf, created_at, last_seen,'
        ' expires_at, ip, ua) VALUES (?,?,?,?,?,?,?,?)',
        (token_hash(tok), user_id, csrf, now, now, now + ABSOLUTE_TIMEOUT,
         ip, (ua or '')[:300]))
    return tok, csrf


def current_session(con, request: Request):
    """The live session row, or None. Touches last_seen."""
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    row = con.execute(
        'SELECT s.*, u.username, u.role, u.must_change_pw, u.is_active,'
        '       u.display_name'
        '  FROM auth_sessions s JOIN users u ON u.id = s.user_id'
        ' WHERE s.id = ?', (token_hash(tok),)).fetchone()
    if not row or row['revoked_at'] or not row['is_active']:
        return None
    now = time.time()
    if now > row['expires_at'] or now - row['last_seen'] > IDLE_TIMEOUT:
        con.execute('UPDATE auth_sessions SET revoked_at=? WHERE id=?',
                    (now, row['id']))
        return None
    con.execute('UPDATE auth_sessions SET last_seen=? WHERE id=?', (now, row['id']))
    return row


def revoke(con, session_id: str) -> None:
    con.execute('UPDATE auth_sessions SET revoked_at=? WHERE id=?',
                (time.time(), session_id))


def revoke_all_for_user(con, user_id: int) -> None:
    con.execute('UPDATE auth_sessions SET revoked_at=?'
                ' WHERE user_id=? AND revoked_at IS NULL', (time.time(), user_id))


def check_csrf(request: Request, session_row) -> None:
    if request.method in ('GET', 'HEAD', 'OPTIONS'):
        return
    sent = request.headers.get('x-csrf-token', '')
    if not sent or not hmac.compare_digest(sent, session_row['csrf']):
        raise HTTPException(status_code=403, detail='csrf')


def set_cookie(response, tok: str, secure: bool) -> None:
    response.set_cookie(
        COOKIE, tok, max_age=ABSOLUTE_TIMEOUT, httponly=True, secure=secure,
        samesite='strict', path=COOKIE_PATH)


def clear_cookie(response, secure: bool) -> None:
    response.delete_cookie(COOKIE, path=COOKIE_PATH, httponly=True,
                           secure=secure, samesite='strict')


def secure_cookies() -> bool:
    # Off only for local development over plain HTTP.
    return os.environ.get('CV_INSECURE_COOKIES', '') != '1'
