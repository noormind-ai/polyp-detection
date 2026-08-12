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

Which is why registration DEFAULTS TO CLOSED here, unlike OrganAI. There,
anyone may sign up but an account grants only the public demo cases — real
patient data needs a separate reviewer list. Here an account IS the key to GPU
spend, so open self-registration would make the gate decorative. Set
POLYP_ALLOW_REGISTER=true (optionally with POLYP_INVITE_CODE) to open it.
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


def check_login(username: str, password: str) -> bool:
    # Read fresh so an account registered a moment ago works immediately, and
    # so a second worker process sees it too.
    stored = load_users().get(username)
    if not stored:
        # Hash anyway so a missing user and a wrong password take the same
        # time — otherwise the response time reveals which usernames exist.
        hash_password(password)
        return False
    if stored.startswith("pbkdf2$"):
        return verify_password(password, stored)
    return hmac.compare_digest(password, stored)


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
