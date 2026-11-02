"""Spectator mode: a read-only websocket for watching a live session from a
second, signed-in-and-allowlisted browser — anywhere on the internet, not
just the clinic LAN.

Deliberately does not touch the primary inference path at all. This route
only subscribes/unsubscribes a socket with backend.services.spectate_bus;
infer.py's _stream_inference is the only thing that ever calls broadcast().

Access is two gates, both required:
  1. signed in (same cookie as the rest of the app)
  2. that username is in POLYP_SPECTATOR_USERS (see backend/auth.py) — being
     signed in to the main app is NOT enough on its own, this is a separate,
     explicit allowlist.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket

from backend import auth
from backend.routes.auth import current_user, require_user
from backend.routes.feedback import _check_id
from backend.services import spectate_bus

log = logging.getLogger("spectate")

router = APIRouter()


def _num(d: dict, key: str, cast, default):
    """Best-effort coercion for telemetry that has no business ever 500ing
    the room's live loop -- a malformed or missing field just falls back
    rather than rejecting the whole report."""
    try:
        return cast(d.get(key, default))
    except (TypeError, ValueError):
        return default


@router.post("/spectate/{case_id}/room-stats")
async def post_room_stats(case_id: str, request: Request,
                          user: str = Depends(require_user)):
    """The room's own client-side connection stats (received count, round
    trip average split server/network, fps) -- a browser-side measurement
    the server has no other way to know, since it only ever sees its own
    side of each request. The room posts here on its own throttle (a couple
    of seconds, not per-frame, see LiveCameraPlayer.tsx) and infer.py's
    broadcast picks up whatever is cached here on the next frame.

    Open, no auth -- same trust level as /ws/infer itself: this is telemetry
    about an already-open, already-unauthenticated connection, not access to
    anything. Fire-and-forget on the room's side, so this must never be
    anything the caller has to retry or handle specially -- always 200."""
    _check_id(case_id, "case_id")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    spectate_bus.set_room_stats(case_id, {
        "sent": _num(body, "sent", int, 0),
        "received": _num(body, "received", int, 0),
        "avg_ms": _num(body, "avg_ms", int, 0),
        "rtt_ms": _num(body, "rtt_ms", int, 0),
        "net_ms": _num(body, "net_ms", int, 0),
        "fps": _num(body, "fps", float, 0.0),
        "uplink_mbps": _num(body, "uplink_mbps", float, 0.0),
    })
    return {"ok": True}


@router.get("/spectate/rooms")
async def list_rooms(user: str | None = Depends(current_user)):
    """Active live-camera sessions right now — what the spectator lobby page
    (/spectator) lists. Same two-gate access as the websocket itself: a plain
    401 for "sign in", 403 for "signed in but not on the allowlist", so the
    lobby page can tell the two apart instead of showing one generic error."""
    if not user:
        raise HTTPException(status_code=401, detail="sign in required")
    if not auth.is_spectator_user(user):
        raise HTTPException(status_code=403, detail="not authorised to spectate")
    return {"rooms": spectate_bus.list_active_rooms()}


@router.websocket("/ws/spectate/{case_id}")
async def spectate_stream(websocket: WebSocket, case_id: str):
    """Accept-then-close-on-reject, same pattern as /ws/infer-file: FastAPI
    can't refuse a websocket before the handshake, so a rejected client gets
    a real close code (1008) instead of a bare connection failure — that's
    what lets the frontend show "not allowed" instead of "server down"."""
    try:
        _check_id(case_id, "case_id")
    except Exception:
        await websocket.accept()
        await websocket.close(code=1008, reason="invalid case_id")
        return

    user = auth.read_session(websocket.cookies.get(auth.COOKIE_NAME, ""))
    if not user or not auth.is_spectator_user(user):
        await websocket.accept()
        await websocket.close(code=1008, reason="not authorised to spectate")
        log.info("spectate WS rejected for case %s: user=%r", case_id, user)
        return

    await websocket.accept()
    spectate_bus.subscribe(case_id, websocket)
    log.info("spectate WS opened | case=%s | user=%s", case_id, user)
    try:
        # Nothing meaningful is ever sent up this socket — this just blocks
        # until the client disconnects, which is the only thing that needs
        # detecting here.
        while True:
            await websocket.receive_text()
    except Exception:
        pass
    finally:
        spectate_bus.unsubscribe(case_id, websocket)
        log.info("spectate WS closed | case=%s | user=%s", case_id, user)
