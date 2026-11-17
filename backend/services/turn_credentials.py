"""Short-lived TURN credentials for the WebRTC relay (coturn).

Standard "TURN REST API" pattern: coturn's `use-auth-secret` mode trusts
any username/password pair where the password is
base64(HMAC-SHA1(shared_secret, username)) and the username encodes an
expiry time. One shared secret lives on both this server (env var,
TURN_SHARED_SECRET) and coturn's own config (/etc/turnserver.conf's
static-auth-secret, same value) -- neither the secret nor a long-lived
password is ever sent to the browser, only a credential that expires on
its own. See documents/webrtc-implementation-plan.txt.
"""
import base64
import hashlib
import hmac
import os
import time

DEFAULT_TTL_S = 3600


def turn_available() -> bool:
    return bool(os.environ.get("TURN_SHARED_SECRET", "").strip())


def generate(ttl_seconds: int = DEFAULT_TTL_S) -> dict | None:
    """-> {"username", "password", "ttl"}, or None if no TURN server is
    configured on this deployment (a box without TURN_SHARED_SECRET set
    simply offers no TURN entry -- callers must treat that as optional,
    same as every other optional-dependency pattern in this codebase)."""
    secret = os.environ.get("TURN_SHARED_SECRET", "").strip()
    if not secret:
        return None
    username = str(int(time.time()) + ttl_seconds)
    password = base64.b64encode(
        hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    ).decode()
    return {"username": username, "password": password, "ttl": ttl_seconds}
