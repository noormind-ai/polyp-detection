"""Server-side recording of a WebRTC live session.

In JPEG mode the browser records the camera itself (MediaRecorder) and
uploads the video in chunks -- see backend/routes/recordings.py. In WebRTC
mode the video is already arriving here as a continuous stream, so this
writes it to disk directly instead: no second encode on the clinic PC and
no second upload over the clinic's link.

What ends up on disk is what arrived live. WebRTC trades completeness for
speed: on a bad link it lowers resolution or drops frames and never resends
them, so a network drop is a gap in the recording. The browser path does not
have that weakness (it stores chunks locally and uploads later); that is the
accepted cost of this path.

File format: H.264 in a FRAGMENTED MP4 while recording -- every fragment is
self-contained, so a server crash mid-procedure leaves a playable file up to
the last fragment rather than nothing (a plain MP4 only becomes playable once
its index is written at the very end). On stop, ffmpeg remuxes it (stream
copy, no re-encode) into a plain MP4 with the index at the front, which is
what makes seeking work in the review panel's "Play from here".

Frames are re-encoded here (aiortc hands us decoded frames, not the H.264
packets). At the streamed size (320px wide by default) that is a small
fraction of one core, and it runs in its own thread so the event loop that
carries inference results never waits on it.
"""
from __future__ import annotations

import logging
import queue
import shutil
import subprocess
import threading
import time
from fractions import Fraction
from typing import Optional

log = logging.getLogger("webrtc_recorder")

# Frames waiting for the encoder thread. Past this the newest frame is
# dropped rather than letting memory grow: a recording with a dropped frame
# is fine, a server out of memory mid-procedure is not.
QUEUE_MAX = 90
# Keyframe every ~2 s at 30 fps: the granularity of seeking, and the most a
# crash can lose from the fragmented file.
GOP = 60
# How often the metadata sidecar is refreshed while recording. Must stay well
# under recordings.STALE_AFTER_S, or a healthy recording is listed as
# "interrupted".
META_EVERY_S = 10
# Frame interval assumed across a pause, so the first frame after resuming
# does not land on the same timestamp as the last one before it.
RESUME_GAP_MS = 33


def _even(n: int) -> int:
    return max(2, n - (n % 2))


# Largest side a browser-declared recording size may have.
MAX_DECLARED_SIDE = 4096


def recording_size(declared, frame_w: int, frame_h: int) -> tuple:
    """Size to open the encoder at. The browser's declared send size when it
    gave a sane one, else the first frame's. Chrome usually OPENS a WebRTC
    stream below the size it was given (e.g. 640x360 for 960x540) and only
    climbs to it seconds later; sizing the file to that first frame locked
    whole recordings at the reduced size (seen 2026-11-24)."""
    if isinstance(declared, (tuple, list)) and len(declared) == 2:
        try:
            w, h = int(declared[0]), int(declared[1])
        except (TypeError, ValueError):
            w = h = 0
        if 2 <= w <= MAX_DECLARED_SIDE and 2 <= h <= MAX_DECLARED_SIDE:
            return _even(w), _even(h)
    return _even(frame_w), _even(frame_h)


class ServerRecording:
    """One recording. Lifecycle: start() -> push()/pause()/resume() -> stop().

    `offset_ms` is the position in the RECORDED video (paused time excluded),
    the same meaning as useSessionRecorder's mark() in the browser path, so a
    capture's video_offset_ms seeks to the right moment either way."""

    def __init__(self, case_id: str, user: str, source: str, transport: str = "webrtc",
                 size=None):
        self.case_id = case_id
        self.size = size  # (w, h) the browser says it sends; see recording_size
        self.user = user
        self.source = source
        self.transport = transport
        self.meta: Optional[dict] = None
        self.paused = False
        self.stopped = False
        self.dropped = 0
        self.frames = 0
        self.offset_ms = 0
        self._seg_frame_t: Optional[float] = None  # frame time at segment start
        self._seg_offset = 0                         # recorded offset at segment start
        self._queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    @property
    def id(self) -> Optional[str]:
        return self.meta["id"] if self.meta else None

    # ---- control (event loop) ------------------------------------------

    def start(self) -> dict:
        """Create the recording entry. The file itself is opened on the first
        frame, because the encoder needs the frame size."""
        from backend.routes import recordings
        self.meta = recordings.open_recording(
            self.case_id, self.user, self.source, "video/mp4",
            extra={"transport": self.transport, "frames": 0, "dropped_frames": 0})
        self._thread = threading.Thread(target=self._run, name=f"rec-{self.id}", daemon=True)
        self._thread.start()
        return self.meta

    def pause(self) -> None:
        self.paused = True
        self._seg_frame_t = None

    def resume(self) -> None:
        if self.paused:
            self.paused = False
            self._seg_offset = self.offset_ms + RESUME_GAP_MS

    def push(self, frame) -> None:
        """Hand one received frame to the encoder. Never blocks."""
        if self.stopped or self.paused or self.meta is None:
            return
        t = frame.time if frame.time is not None else time.monotonic()
        if self._seg_frame_t is None:
            self._seg_frame_t = t
        offset = self._seg_offset + int(round((t - self._seg_frame_t) * 1000))
        if offset <= self.offset_ms and self.frames:
            offset = self.offset_ms + 1  # timestamps must strictly increase
        try:
            self._queue.put_nowait((frame, offset))
            self.offset_ms = offset
        except queue.Full:
            self.dropped += 1

    def stop(self, reason: str = "manual") -> dict:
        """Blocking: flush the encoder, finalize the file, mark complete.
        Call from a worker thread (asyncio.to_thread), not the event loop."""
        if self.stopped or self.meta is None:
            return self.meta or {}
        self.stopped = True
        self._queue.put(None)
        if self._thread:
            self._thread.join(timeout=60)
        from backend.routes import recordings
        path = recordings.video_path(self.meta)
        if self.frames and path.exists() and path.stat().st_size:
            _remux_faststart(path)
        now = int(time.time())
        with self._lock:
            if self.meta.get("status") == "recording":
                self.meta["status"] = "complete"
            self.meta.update(ended_at=now, updated_at=now, duration_ms=self.offset_ms,
                             stop_reason=reason, frames=self.frames,
                             dropped_frames=self.dropped)
            recordings.write_meta(self.meta)
        log.info("server recording %s stopped (%s): %d frames, %d dropped, %.1fs",
                 self.id, reason, self.frames, self.dropped, self.offset_ms / 1000)
        return self.meta

    # ---- encoder thread ------------------------------------------------

    def _run(self) -> None:
        import av
        from backend.routes import recordings
        path = recordings.video_path(self.meta)
        limit = recordings.MAX_RECORDING_MB * 1024 * 1024
        container = stream = None
        last_meta = time.monotonic()
        try:
            while True:
                item = self._queue.get()
                if item is None:
                    break
                frame, offset = item
                if container is None:
                    w, h = recording_size(self.size, frame.width, frame.height)
                    container = av.open(str(path), mode="w", format="mp4", options={
                        "movflags": "frag_keyframe+empty_moov+default_base_moof"})
                    stream = container.add_stream("libx264", rate=30)
                    stream.width, stream.height = w, h
                    stream.pix_fmt = "yuv420p"
                    stream.time_base = Fraction(1, 1000)
                    stream.codec_context.time_base = Fraction(1, 1000)
                    stream.options = {"preset": "veryfast", "crf": "23", "g": str(GOP)}
                    with self._lock:
                        self.meta.update(width=w, height=h)
                # WebRTC may change resolution mid-stream under congestion;
                # the encoder's size is fixed, so every frame is fitted to it.
                out = frame.reformat(width=stream.width, height=stream.height, format="yuv420p")
                out.pts = offset
                out.time_base = Fraction(1, 1000)
                for packet in stream.encode(out):
                    container.mux(packet)
                self.frames += 1

                if time.monotonic() - last_meta >= META_EVERY_S:
                    last_meta = time.monotonic()
                    size = path.stat().st_size if path.exists() else 0
                    with self._lock:
                        self.meta.update(updated_at=int(time.time()), duration_ms=self.offset_ms,
                                         frames=self.frames, dropped_frames=self.dropped)
                        if size >= limit:
                            self.meta["status"] = "truncated"
                            self.stopped = True
                            log.warning("server recording %s hit the size cap", self.id)
                        recordings.write_meta(self.meta)
                    if self.stopped:
                        break
        except Exception:
            log.exception("server recording %s encoder failed", self.id)
            with self._lock:
                self.meta["status"] = "error"
                self.stopped = True
                recordings.write_meta(self.meta)
        finally:
            if container is not None:
                try:
                    for packet in stream.encode(None):
                        container.mux(packet)
                except Exception:
                    log.exception("server recording %s flush failed", self.id)
                container.close()


def _remux_faststart(path) -> None:
    """Fragmented MP4 -> plain MP4 with the index up front, stream copy. Same
    swap-only-on-success pattern as scripts/finalize_stale_recordings.py: a
    failed remux leaves the fragmented file, which still plays."""
    if not shutil.which("ffmpeg"):
        log.warning("ffmpeg not found; %s left fragmented (plays, seeks poorly)", path)
        return
    tmp = path.with_name(path.stem + ".remux-tmp" + path.suffix)
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-c", "copy",
         "-movflags", "+faststart", "-y", str(tmp)],
        capture_output=True, text=True, timeout=600)
    if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        log.warning("remux of %s failed: %s", path, proc.stderr.strip()[:200])
        tmp.unlink(missing_ok=True)
        return
    tmp.replace(path)
