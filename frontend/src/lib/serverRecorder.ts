/** The recording controls for WebRTC mode, where the SERVER records.
 *
 *  In JPEG mode the browser records (useSessionRecorder: MediaRecorder,
 *  local chunk store, chunked upload). In WebRTC mode the video is already
 *  streaming to the server, so the server writes it to disk itself
 *  (backend/services/webrtc_recorder.py) and this object only sends it
 *  commands over the WebRTC signaling socket.
 *
 *  It deliberately has the same start/pause/resume/stop/mark shape as
 *  useSessionRecorder, so LiveCameraPlayer's applyAutoRecord -- in-body
 *  auto start/pause, out-of-body auto stop, case rotation -- drives either
 *  one without knowing which it has. Same contract too: every call is safe
 *  to repeat (start while recording, pause while paused, ... are no-ops), because
 *  applyAutoRecord calls them on every evaluated frame.
 */

export type ServerRecState = "idle" | "starting" | "recording" | "paused" | "error";

export type ServerRecSnapshot = {
  state: ServerRecState;
  recordingId: string | null;
  /** Recorded length so far (paused time excluded), from the server. */
  offsetMs: number;
  error: string | null;
};

export type RecorderLike = {
  start: () => unknown;
  pause: (opts?: { trickle?: boolean }) => void;
  resume: () => void;
  stop: (reason?: string) => void;
  mark: () => { recordingId: string; offsetMs: number } | null;
};

export type ServerRecorder = RecorderLike & {
  /** Feed every message the server sends with type "recording". */
  onServerMessage: (data: { state?: string; recording_id?: string; error?: string }) => void;
  /** Feed the `rec` field of each inference result: where that frame sits. */
  noteMark: (rec: { id?: string; offset_ms?: number } | undefined) => void;
  snapshot: () => ServerRecSnapshot;
  /** The connection was rebuilt (webrtcRecovery.ts): the server already
   *  finalized the old recording as "disconnect" and will never reply about
   *  it. Forget it, so the auto-record rules start a fresh one. */
  reset: () => void;
};

export function createServerRecorder(opts: {
  send: (msg: object) => boolean;
  /** Read at start time, not creation time: the case id rotates per patient
   *  while one session stays open (see onCaseEnd in LiveCameraPlayer). */
  caseId: () => string;
  source: () => "camera" | "screen";
  onChange: (s: ServerRecSnapshot) => void;
  onComplete?: () => void;
}): ServerRecorder {
  let snap: ServerRecSnapshot = { state: "idle", recordingId: null, offsetMs: 0, error: null };
  // What we last ASKED for. Server replies arrive later; deduplicating on
  // this keeps one in-body frame per 100 ms from becoming one message each.
  let wanted: "idle" | "recording" | "paused" = "idle";
  // Set when the server refused to start (full disk, bad case id). Without
  // it the very next in-body frame would ask again, every 100 ms, forever.
  // Cleared by stop() -- i.e. by the next real out-of-body stop or a manual
  // one -- so a later procedure still gets a fresh attempt.
  let blocked = false;

  const set = (patch: Partial<ServerRecSnapshot>) => {
    snap = { ...snap, ...patch };
    opts.onChange(snap);
  };

  return {
    start() {
      if (blocked || wanted !== "idle") return;
      wanted = "recording";
      if (opts.send({ type: "record", action: "start", case_id: opts.caseId(), source: opts.source() })) {
        set({ state: "starting", error: null, offsetMs: 0 });
      } else {
        wanted = "idle";
      }
    },
    pause() {
      if (wanted !== "recording") return;
      wanted = "paused";
      opts.send({ type: "record", action: "pause" });
    },
    resume() {
      if (wanted !== "paused") return;
      wanted = "recording";
      opts.send({ type: "record", action: "resume" });
    },
    stop(reason = "manual") {
      blocked = false;
      if (wanted === "idle") return;
      wanted = "idle";
      opts.send({ type: "record", action: "stop", reason });
    },
    mark() {
      if (snap.state !== "recording" || !snap.recordingId) return null;
      return { recordingId: snap.recordingId, offsetMs: snap.offsetMs };
    },
    onServerMessage(data) {
      switch (data.state) {
        case "recording":
        case "paused":
          set({ state: data.state, recordingId: data.recording_id ?? snap.recordingId });
          break;
        case "complete":
          // Only clear if this is the recording we think is open -- a stop
          // reply landing after a fresh start must not wipe the new one.
          if (!snap.recordingId || snap.recordingId === data.recording_id) {
            set({ state: "idle", recordingId: null, offsetMs: 0 });
          }
          opts.onComplete?.();
          break;
        case "idle":
          wanted = "idle";
          set({ state: "idle", recordingId: null });
          break;
        case "error":
          wanted = "idle";
          blocked = true;
          set({ state: "error", error: data.error ?? "recording failed" });
          break;
      }
    },
    noteMark(rec) {
      if (!rec?.id || typeof rec.offset_ms !== "number") return;
      if (rec.id !== snap.recordingId) return;
      // Only a visible change is worth a re-render.
      if (Math.floor(rec.offset_ms / 1000) !== Math.floor(snap.offsetMs / 1000)) {
        set({ offsetMs: rec.offset_ms });
      } else {
        snap = { ...snap, offsetMs: rec.offset_ms };
      }
    },
    snapshot: () => snap,
    reset() {
      wanted = "idle";
      blocked = false;
      set({ state: "idle", recordingId: null, offsetMs: 0, error: null });
    },
  };
}
