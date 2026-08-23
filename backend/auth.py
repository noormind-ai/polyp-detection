"""Username/password login with signed session cookies.

Ported from OrganAI's api/auth.py, deliberately as a copy rather than a shared
package: the two apps are separate repos with independent release cycles, and
coupling them would mean a polyp deploy could break an OrganAI login. The
design notes below are the ones that matter for keeping the copy correct.

* Passwords are stored HASHED (PBKDF2-HMAC-SHA256, 240k iterations, per-user
  salt). The server never holds a plaintext password.
* Sessions are stateless: the cookie carries `user|expiry|HMAC`. Nothing is
  stored server-side, so a pm2 restart does not sign everyone out, and there
  is no session table to grow.
* Every comparison uses hmac.compare_digest — a plain `==` on a secret leaks
  information through timing.
* No new dependencies: hashlib and hmac are in the standard library.

What login actually gates here
------------------------------
Only the paths that push a NEW video through the GPU: the whole-file upload
and the frame-by-frame upload player. Live camera and screen share are open on
purpose — they are the real clinical use — and the bundled demos are open
because they no longer touch the GPU at all (their detections are precomputed;
see data/precompute_demos.py).

Registration DEFAULTS TO CLOSED, because where an upload costs GPU time an
account IS the key to that spend and open self-registration would make the gate
decorative. Set POLYP_ALLOW_REGISTER=true (optionally with POLYP_INVITE_CODE)
to open it — the CPU-only deployments do, since there a stranger's upload costs
one box's own cores rather than a GPU bill.

ONE LOGIN, TWO KINDS OF ACCOUNT
-------------------------------
There is a single sign-in form for the whole site — the app at / and the
clinical review panel at /review — and it accepts both kinds of account:

  signed up here    can upload video. Cannot review: the panel authorises
                    against its own users table and has never heard of them.
  issued by a panel can do both. Reviewer accounts exist ONLY because an admin
  admin             created one; no route anywhere makes one.

So the login is shared and the ACCESS is what differs. See "Review-panel
accounts" at the foot of this file for how the second kind is checked.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

ITERATIONS = 240_000
COOKIE_NAME = "polyp_session"
SESSION_HOURS = int(os.environ.get("POLYP_SESSION_HOURS", "12"))

# Signing key for session cookies. If unset, one is generated per process —
# which means sessions silently stop working across a restart or a second
# worker, so a real deployment should set it explicitly.
SECRET = os.environ.get("POLYP_SECRET", "") or secrets.token_hex(32)
SECRET_IS_EPHEMERAL = not os.environ.get("POLYP_SECRET", "")

# Alongside the feedback data, on the same volume, so registered accounts
# survive a redeploy. `data/` is gitignored.
USER_FILE = Path(__file__).resolve().parent / "data" / "users.json"


def hash_password(password: str, salt: bytes = None) -> str:
    """-> 'pbkdf2$<iterations>$<salt_b64>$<hash_b64>', safe to store."""
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return "pbkdf2${}${}${}".format(
        ITERATIONS,
        base64.b64encode(salt).decode(),
        base64.b64encode(dk).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iters, salt_b64, hash_b64 = stored.split("$")
        if scheme != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(),
                                 base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False


# Default account, used when POLYP_USERS is not set. Setting POLYP_USERS
# REPLACES this entirely — it is a starting point, not a permanent back door.
DEFAULT_USER = "clinician"
DEFAULT_PASSWORD = "noormind"


def _env_users() -> dict:
    """Accounts from POLYP_USERS: 'alice:pbkdf2$...,bob:secret'.

    Passwords may be a PBKDF2 hash (from `python -m backend.auth <password>`)
    or plaintext. Plaintext is accepted so an account can be set up without a
    hashing step; it means anyone who can read the environment can read it.
    """
    raw = os.environ.get("POLYP_USERS", "").strip()
    users = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        name, _, secret = entry.partition(":")
        users[name.strip()] = secret.strip()
    return users


def _file_users() -> dict:
    if not USER_FILE.exists():
        return {}
    try:
        return json.loads(USER_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def load_users() -> dict:
    """The default account, then registered ones, then env accounts.

    The default is present whenever POLYP_USERS is unset — NOT merely when
    there are no users at all. Guarding it with `users or {default}` would mean
    the operator login vanishes the moment the first person self-registers,
    locking the owner out of their own deployment.

    Env accounts are applied last so a deployment can pin a login that
    self-registration cannot displace.
    """
    env = _env_users()
    users = {} if env else {DEFAULT_USER: DEFAULT_PASSWORD}
    users.update(_file_users())
    users.update(env)
    return users


def using_default_credentials() -> bool:
    return load_users().get(DEFAULT_USER) == DEFAULT_PASSWORD


# Closed by default — see the module docstring for why this differs from OrganAI.
REGISTRATION_OPEN = os.environ.get("POLYP_ALLOW_REGISTER", "false").lower() in ("1", "true", "yes")
INVITE_CODE = os.environ.get("POLYP_INVITE_CODE", "")

USERNAME_MIN, PASSWORD_MIN = 3, 6


class RegisterError(Exception):
    """Message intended to be shown to the user."""


def register_user(username: str, password: str, invite: str = "") -> None:
    username = (username or "").strip()
    if not REGISTRATION_OPEN:
        raise RegisterError("ثبت‌نام غیرفعال است. Registration is disabled — ask an administrator for an account.")
    if INVITE_CODE and not hmac.compare_digest(invite or "", INVITE_CODE):
        raise RegisterError("کد دعوت نادرست است. Invalid invite code.")
    if len(username) < USERNAME_MIN or not username.replace("_", "").replace("-", "").isalnum():
        raise RegisterError(
            f"نام کاربری باید حداقل {USERNAME_MIN} نویسه و فقط حروف/عدد باشد. "
            f"Username must be at least {USERNAME_MIN} characters, letters and digits only.")
    if len(password or "") < PASSWORD_MIN:
        raise RegisterError(
            f"رمز عبور باید حداقل {PASSWORD_MIN} نویسه باشد. "
            f"Password must be at least {PASSWORD_MIN} characters.")
    if username in load_users() or username == DEFAULT_USER:
        raise RegisterError("این نام کاربری قبلاً گرفته شده است. That username is taken.")

    users = _file_users()
    users[username] = hash_password(password)   # never store the plaintext
    USER_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = USER_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(users, indent=1), encoding="utf-8")
    tmp.replace(USER_FILE)                      # atomic: no half-written file


# What login_status() can answer. Anything but OK means no session is issued;
# MUST_CHANGE_PW is the one case where the password was RIGHT.
OK = "ok"
MUST_CHANGE_PW = "must_change_password"
NO = "no"


def login_status(username: str, password: str) -> str:
    """OK / MUST_CHANGE_PW / NO — the single answer the sign-in form uses.

    Local accounts first, then the review panel, so a name held in both is
    whichever this app knows about. MUST_CHANGE_PW is reported rather than
    folded into NO because the credentials were correct and the person has
    something to DO about it — answering "wrong password" instead sends them off
    to reset a password that was never the problem. It reveals no more than the
    panel's own login already does, which returns must_change_pw on success.
    """
    # Read fresh so an account registered a moment ago works immediately, and
    # so a second worker process sees it too.
    stored = load_users().get(username)
    if not stored:
        # Hash anyway so a missing user and a wrong password take the same
        # time — otherwise the response time reveals which usernames exist.
        hash_password(password)
        # Not one of ours: it may still be a reviewer from the validation
        # panel, who is the same person and should not need a second account.
        return panel_login_status(username, password)
    ok = (verify_password(password, stored) if stored.startswith("pbkdf2$")
          else hmac.compare_digest(password, stored))
    return OK if ok else NO


def check_login(username: str, password: str) -> bool:
    """True only when a session may be issued right now."""
    return login_status(username, password) == OK


def issue_session(username: str) -> str:
    expiry = int(time.time()) + SESSION_HOURS * 3600
    payload = f"{username}|{expiry}"
    sig = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode()


def read_session(cookie: str) -> str | None:
    """-> username, or None if missing/tampered/expired."""
    if not cookie:
        return None
    try:
        raw = base64.urlsafe_b64decode(cookie.encode()).decode()
        username, expiry, sig = raw.rsplit("|", 2)
        expect = hmac.new(SECRET.encode(), f"{username}|{expiry}".encode(),
                          hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return None
        if int(expiry) < time.time():
            return None
        return username
    except Exception:
        return None


if __name__ == "__main__":
    # Helper: python -m backend.auth <password> -> a hash to paste into POLYP_USERS
    import sys
    if len(sys.argv) != 2:
        print("usage: python -m backend.auth <password>")
        raise SystemExit(1)
    print(hash_password(sys.argv[1]))


# ---------------------------------------------------------------------------
# Review-panel accounts
# ---------------------------------------------------------------------------
# A reviewer created in the clinical validation panel is the same person as a
# user of this app, and should not need a second set of credentials. So a login
# that fails against this app's own users is retried against the panel's.
#
# The trust is deliberately ONE WAY. A panel account works here; an account
# created HERE never gains anything in the panel, because self-signup is open
# in this app and the panel guards patient images. Nothing in this file can
# grant panel access -- the panel authorises against its own users table and
# has no idea this code exists.
#
# Read-only, and only ever consulted after the local store has said no.
PANEL_DB = os.environ.get(
    "POLYP_PANEL_DB",
    "/home/fati/noormind/clinical-validation/data/panel.db")


def is_panel_user(username: str) -> bool:
    """True if this name is a live account in the review panel.

    Used only to decide whether to show the panel's link. It grants nothing:
    the panel checks its own users table on every request and does not trust
    anything this app says.
    """
    if not username or not os.path.exists(PANEL_DB):
        return False
    try:
        import sqlite3
        con = sqlite3.connect("file:%s?mode=ro" % PANEL_DB, uri=True, timeout=5)
        try:
            row = con.execute(
                "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE"
                " AND is_active = 1", (username.strip(),)).fetchone()
        finally:
            con.close()
        return bool(row)
    except Exception:
        return False


def panel_login_status(username: str, password: str) -> str:
    """OK / MUST_CHANGE_PW / NO for a review-panel account.

    Argon2id, verified with the panel's own library.

    A reviewer still holding the one-time password an admin issued gets
    MUST_CHANGE_PW, not a session. That password was dictated or messaged to
    them out of band; it must not quietly become a permanent credential for a
    second application. Same rule the panel applies before showing a single
    image — and with a shared login form it costs one extra step instead of
    being a locked door, which is what it used to be when this returned a bare
    False and the caller told someone with a perfectly correct password that it
    was incorrect.
    """
    if not username or not password or not os.path.exists(PANEL_DB):
        return NO
    try:
        import sqlite3
        from argon2 import PasswordHasher
        from argon2.exceptions import (VerifyMismatchError, VerificationError,
                                       InvalidHashError)
    except Exception:
        return NO
    try:
        con = sqlite3.connect("file:%s?mode=ro" % PANEL_DB, uri=True, timeout=5)
        try:
            row = con.execute(
                "SELECT pw_hash, is_active, must_change_pw FROM users"
                " WHERE username = ? COLLATE NOCASE", (username.strip(),)
            ).fetchone()
        finally:
            con.close()
    except Exception:
        return NO
    if not row:
        return NO
    pw_hash, is_active, must_change = row
    if not is_active:
        return NO
    try:
        PasswordHasher().verify(pw_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return NO
    except Exception:
        return NO
    return MUST_CHANGE_PW if must_change else OK


def check_panel_login(username: str, password: str) -> bool:
    return panel_login_status(username, password) == OK


def panel_role(username: str) -> str | None:
    """'admin' / 'reader' for a live panel account, else None.

    Display only, exactly like is_panel_user: it decides whether to offer the
    link to /review, and grants nothing. An account made by the signup form has
    no row here at all, so it gets None, is never shown the link, and would be
    turned away by the panel even if it guessed the URL.
    """
    if not username or not os.path.exists(PANEL_DB):
        return None
    try:
        import sqlite3
        con = sqlite3.connect("file:%s?mode=ro" % PANEL_DB, uri=True, timeout=5)
        try:
            row = con.execute(
                "SELECT role FROM users WHERE username = ? COLLATE NOCASE"
                " AND is_active = 1", (username.strip(),)).fetchone()
        finally:
            con.close()
        return row[0] if row else None
    except Exception:
        return None
