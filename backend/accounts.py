"""Per-user access grants: who may open live video, the recordings archive, and
spectator view -- and who may hand those out.

WHY THIS IS NOT PART OF auth.py
-------------------------------
auth.py answers "are these credentials good", and it answers it for two
independent stores: accounts registered in this app (users.json) and reviewer
accounts a panel admin issued (panel.db, read only). This file answers a
different question -- "what may this name reach" -- and answers it for BOTH
stores with one record type, keyed by username.

Keeping the two apart is what lets an admin grant a reviewer access to live
video without this app ever writing to the panel's database. The one-way trust
described at the foot of auth.py is untouched: credentials still open nothing by
themselves, and a grant is the only thing that opens a door.

DEFAULT IS DENY
---------------
A username with no record here can do nothing beyond signing in. Signup is open
on this box (POLYP_ALLOW_REGISTER=true), so that default is the whole point: it
is what stops someone who registered a moment ago from opening an archive of
patient video. It also means a typo in a username grants nothing rather than
everything.

The one deliberate exception is ADMIN_FALLBACK -- see is_admin().

NO DATABASE
-----------
Same shape as users.json next to it: one JSON file, read fresh on every call so
a grant takes effect without a restart, written tmp-then-replace so a crash
never leaves a half-written file. Stdlib only, no new dependency. Every change
is appended to accounts-audit.jsonl, because "who could see the recordings in
March" is a question that gets asked after the fact.
"""
import json
import logging
import os
import time
from pathlib import Path

log = logging.getLogger("accounts")

# Beside users.json on the same volume, so grants survive a redeploy. data/ is
# gitignored -- this file names real people and must not enter the repo.
STORE = Path(__file__).resolve().parent / "data" / "accounts.json"
AUDIT = Path(__file__).resolve().parent / "data" / "accounts-audit.jsonl"

# The grantable capabilities, written down once. Adding another -- "upload", say
# -- is one entry here plus one dependency on the route that needs it.
#
#   live        start a live camera / screen-share session, record it to this
#               server, and file feedback captures from it
#   recordings  open the archive of sessions already recorded here
#   spectator   watch somebody else's live session from another computer
#   admin       reach /admin: create accounts and change these grants
CAPS = ("live", "recordings", "spectator", "admin")

# recordings is the one capability that is not a yes/no. A recording stores the
# name of whoever made it (recordings.py, meta["user"]), so "own" is a real
# enforceable answer and not merely a hint to the UI.
RECORDINGS_LEVELS = (None, "own", "all")

# Names that are admins no matter what the store says. Without an escape hatch,
# one bad edit to accounts.json locks everybody out of the screen that fixes
# accounts.json -- the same reasoning as the comment in auth.load_users() about
# never letting the operator login vanish.
ADMIN_FALLBACK = {
    u.strip() for u in os.environ.get("POLYP_ADMIN_USERS", "").split(",") if u.strip()
}

DENY = {"live": False, "recordings": None, "spectator": False, "admin": False}


def _empty() -> dict:
    return {"version": 1, "grants": {}, "must_change": []}


def _load() -> dict:
    """The store as it is on disk right now. A missing or unreadable file reads
    as empty, which denies everything -- failing closed is the right direction
    for a permissions file, and the admin screen will show it as such."""
    if not STORE.exists():
        return _empty()
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.error("accounts.json unreadable (%s) -- denying everything until fixed", e)
        return _empty()
    if not isinstance(data, dict):
        return _empty()
    data.setdefault("version", 1)
    if not isinstance(data.get("grants"), dict):
        data["grants"] = {}
    if not isinstance(data.get("must_change"), list):
        data["must_change"] = []
    return data


def _save(data: dict) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STORE)                      # atomic: no half-written file


def _key(data: dict, username: str) -> str | None:
    """The stored key matching this name, case-insensitively.

    The panel's users table is COLLATE NOCASE, so Mmalekzadeh and mmalekzadeh
    are one person there. Matching exactly here would mean an admin who typed
    the name in the wrong case silently granted nothing to nobody, while the UI
    showed the grant sitting on a username that cannot sign in.
    """
    if not username:
        return None
    name = username.strip().lower()
    for stored in data.get("grants", {}):
        if stored.strip().lower() == name:
            return stored
    return None


def _normalise(record) -> dict:
    """A stored record as the rest of the app wants it: every capability
    present, wrong types coerced, unknown keys dropped."""
    out = dict(DENY)
    if not isinstance(record, dict):
        return out
    out["live"] = bool(record.get("live"))
    out["spectator"] = bool(record.get("spectator"))
    out["admin"] = bool(record.get("admin"))
    level = record.get("recordings")
    out["recordings"] = level if level in RECORDINGS_LEVELS else None
    return out


# --------------------------------------------------------------------- reading

def grants_for(username: str) -> dict:
    """Every capability for one name. Unknown name -> everything denied."""
    data = _load()
    key = _key(data, username)
    return _normalise(data["grants"].get(key) if key else None)


def may(username: str, cap: str) -> bool:
    """Yes/no for one capability. For `recordings` this is "at all" -- call
    recordings_scope() when the difference between own and all matters."""
    if cap not in CAPS:
        raise ValueError("unknown capability %r" % cap)
    if cap == "admin":
        return is_admin(username)
    return bool(grants_for(username)[cap])


def recordings_scope(username: str):
    """None / 'own' / 'all'."""
    return grants_for(username)["recordings"]


def is_admin(username: str) -> bool:
    """The admin grant, a panel administrator, or POLYP_ADMIN_USERS.

    The last two are the lock-out escape hatch described at the top of the file.
    A panel admin qualifies because that account was itself issued by an admin
    and already administers the half of the site holding patient images --
    requiring a second, separate grant to reach THIS screen would just mean
    nobody could reach it on the day it ships.

    auth is imported inside the function on purpose: auth.py imports this module
    (is_spectator_user reads a grant), so importing it back at module level would
    be a cycle. The call is a read-only sqlite lookup, not worth caching.
    """
    if not username:
        return False
    if username.strip() in ADMIN_FALLBACK:
        return True
    if grants_for(username)["admin"]:
        return True
    from backend import auth                 # local: see docstring
    return auth.panel_role(username) == "admin"


def all_grants() -> dict:
    """Every record, normalised. For the admin screen's table."""
    data = _load()
    return {name: _normalise(rec) for name, rec in data["grants"].items()}


def must_change_list() -> list:
    return list(_load()["must_change"])


# --------------------------------------------------------------------- writing

def set_grants(username: str, patch: dict, actor: str) -> dict:
    """Change some capabilities for one name, leaving the rest alone.

    `patch` carries only what is being changed, so the admin screen can toggle
    one checkbox without having to send -- and risk clobbering -- the others.
    """
    username = (username or "").strip()
    if not username:
        raise ValueError("username required")
    unknown = set(patch) - set(CAPS)
    if unknown:
        raise ValueError("unknown capability: %s" % ", ".join(sorted(unknown)))
    if "recordings" in patch and patch["recordings"] not in RECORDINGS_LEVELS:
        raise ValueError("recordings must be one of: null, own, all")

    data = _load()
    key = _key(data, username) or username
    before = _normalise(data["grants"].get(key))
    after = _normalise({**before, **{k: v for k, v in patch.items() if k in CAPS}})

    record = dict(after)
    record["updated_at"] = int(time.time())
    record["updated_by"] = actor
    data["grants"][key] = record
    _save(data)

    changed = {k: (before[k], after[k]) for k in CAPS if before[k] != after[k]}
    if changed:
        audit(actor, "grants_changed", key,
              ", ".join("%s: %r -> %r" % (k, a, b) for k, (a, b) in changed.items()))
    return after


def forget(username: str, actor: str) -> None:
    """Drop a name's record entirely -- which denies everything, since absence
    is denial. Used when an app account is removed, so stale grants are not left
    waiting for someone to register the same username again."""
    data = _load()
    key = _key(data, username)
    if not key:
        return
    data["grants"].pop(key, None)
    data["must_change"] = [u for u in data["must_change"]
                           if u.strip().lower() != key.strip().lower()]
    _save(data)
    audit(actor, "grants_removed", key, None)


# ------------------------------------------------- admin-issued passwords

def needs_password_change(username: str) -> bool:
    """True while this app account still holds the one-time password an admin
    issued. The panel has had this rule since it existed (its users table has
    must_change_pw); app accounts need it now that an admin can create one, and
    for the same reason -- a password read out over the phone must not quietly
    become a permanent credential."""
    name = (username or "").strip().lower()
    return any(u.strip().lower() == name for u in _load()["must_change"])


def mark_password_change(username: str) -> None:
    username = (username or "").strip()
    if needs_password_change(username):
        return
    data = _load()
    data["must_change"].append(username)
    _save(data)


def clear_password_change(username: str) -> None:
    data = _load()
    name = (username or "").strip().lower()
    keep = [u for u in data["must_change"] if u.strip().lower() != name]
    if len(keep) != len(data["must_change"]):
        data["must_change"] = keep
        _save(data)


# ----------------------------------------------------------------------- audit

def audit(actor: str, action: str, subject=None, detail=None) -> None:
    """Append-only, one JSON object per line. Never raises: an audit write that
    failed must not be the reason a grant could not be given."""
    line = json.dumps({"ts": int(time.time()), "actor": actor, "action": action,
                       "subject": subject, "detail": detail}, ensure_ascii=False)
    try:
        AUDIT.parent.mkdir(parents=True, exist_ok=True)
        with AUDIT.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError as e:
        log.warning("could not write audit line (%s): %s", e, line)
