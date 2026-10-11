"""In-memory pub/sub so a live inference session can be watched by a second,
read-only browser (spectator mode) without touching the primary inference
path at all.

Still deliberately minimal, not a general session registry: infer.py knows
nothing about "sessions" beyond a bare case_id string on the query string.
This module tracks two things and nothing more — who wants to be told about a
case_id's frames (_subscribers), and which case_ids currently have a live room
to watch (_active_rooms, so the spectator lobby page has something to list).
Both are pure in-memory bookkeeping: a server restart clears them, same as
every other case_id-keyed thing in this app (case IDs themselves are never
persisted either — see infer.py's _new_case_id).

Nothing here may ever raise into the caller — broadcast() is invoked
fire-and-forget from the hot per-frame loop in infer.py, and a spectator-side
problem (a slow consumer, a dead socket) must never slow or break the primary
client's response.
"""

import asyncio
import json
import logging
import time

from fastapi import WebSocket

log = logging.getLogger("spectate_bus")

# One send may not hang around waiting for a stalled spectator connection —
# that would let a single bad viewer back up delivery to everyone else.
SEND_TIMEOUT_S = 2.0

_subscribers: dict[str, set[WebSocket]] = {}
_active_rooms: dict[str, dict] = {}
# The room's own client-side connection stats (received count, round-trip
# average split into server/network, fps) -- a browser-side measurement the
# server has no other way to know, since it only sees its own side of each
# request. The room POSTs these to /api/spectate/{case_id}/room-stats on its
# own throttle (a couple of seconds, not per-frame); this is just the latest
# value, overwritten each time, not a history.
_room_stats: dict[str, dict] = {}


def mark_room_active(case_id: str, engine: str) -> None:
    """Called once when a real live-camera session's websocket opens (see
    infer.py's infer_stream) — this is what makes a session show up in the
    spectator lobby. Never called for file-replay sessions (/ws/infer-file):
    those are one person's own test, not a room for anyone else to watch."""
    _active_rooms[case_id] = {"case_id": case_id, "started_at": time.time(), "engine": engine}


def mark_room_inactive(case_id: str) -> None:
    _active_rooms.pop(case_id, None)
    _room_stats.pop(case_id, None)


def set_room_stats(case_id: str, stats: dict) -> None:
    _room_stats[case_id] = stats


def get_room_stats(case_id: str) -> dict | None:
    return _room_stats.get(case_id)


def list_active_rooms() -> list[dict]:
    """Newest first — the room someone just started is the one most likely
    to be the one being asked about."""
    return sorted(_active_rooms.values(), key=lambda r: r["started_at"], reverse=True)


def subscribe(case_id: str, ws: WebSocket) -> None:
    _subscribers.setdefault(case_id, set()).add(ws)


def unsubscribe(case_id: str, ws: WebSocket) -> None:
    subs = _subscribers.get(case_id)
    if not subs:
        return
    subs.discard(ws)
    if not subs:
        _subscribers.pop(case_id, None)


def has_subscribers(case_id: str) -> bool:
    """Checked before doing any work for a broadcast — a procedure with
    nobody watching should cost the main loop one dict lookup, nothing more."""
    return bool(_subscribers.get(case_id))


async def _safe_send(ws: WebSocket, case_id: str, text: str) -> None:
    try:
        await asyncio.wait_for(ws.send_text(text), timeout=SEND_TIMEOUT_S)
    except Exception:
        # Dead or stalled — drop them. They'll notice on their own socket and
        # can reconnect; this function's only job is to never let that block
        # or fail the frame currently being served to the room.
        unsubscribe(case_id, ws)


async def broadcast(case_id: str, payload: dict) -> None:
    """Best-effort fan-out. Never raises — every failure mode ends up as a
    dropped subscriber, not an exception the caller has to handle."""
    subs = _subscribers.get(case_id)
    if not subs:
        return
    try:
        text = json.dumps(payload)
        # Snapshot before iterating: unsubscribe() can mutate the live set
        # concurrently (a spectator disconnecting mid-broadcast).
        targets = list(subs)
        await asyncio.gather(
            *(_safe_send(ws, case_id, text) for ws in targets),
            return_exceptions=True,
        )
    except Exception:
        log.warning("spectate broadcast failed for case %s", case_id, exc_info=True)
