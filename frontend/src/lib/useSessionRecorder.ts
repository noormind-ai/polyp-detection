"use client";

/**
 * Records a whole live session to the server, on demand.
 *
 * Not the same thing as useRollingClip: that keeps a few seconds in memory so a
 * feedback capture can attach "what led up to this", and never touches the
 * server on its own. This one runs from an explicit Start to an explicit Stop
 * and streams the result to disk.
 *
 * It records the SOURCE MediaStream, not the <video> element's captureStream —
 * so the archive is the camera's own frames at their native resolution, not
 * whatever the page happened to be painting, and it is unaffected by the
 * element being hidden or the panels being toggled off.
 *
 * Chunks are written to durable local storage (`chunkStore.ts` — OPFS, then
 * IndexedDB, then RAM as a last resort) as they're produced, and only
 * uploaded once the session ends. A crashed tab / OOM / power loss before Stop
 * loses at most the last unflushed chunk, not the whole procedure — unlike a
 * plain in-memory array, which is gone the instant the tab is.
 *
 * Upload happens strictly one chunk at a time, in order: a WebM is only valid
 * if its clusters are concatenated in order, and the server refuses an
 * out-of-order `seq` outright. Each chunk also waits for
 * `uploadCoordinator.waitUntilInferenceIdle()` before sending — if the next
 * procedure has already started in this tab by the time this upload gets
 * around to running, its live inference frames get the link, not this
 * recording. A chunk that cannot be delivered after a retry stops the
 * recording rather than leaving a hole in a video that still looks fine in
 * the list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { openChunkStore, type ChunkStore, type ChunkStoreKind } from "./chunkStore";
import { waitUntilInferenceIdle, isLiveInferenceActive } from "./uploadCoordinator";
import { registerUpload, updateUpload, finishUpload } from "./uploadRegistry";

const API = process.env.NEXT_PUBLIC_API_URL || "";

/** How much video each upload carries. Short enough that a crash loses little,
 *  long enough that a 40-minute procedure is ~800 requests, not ~24,000. */
const CHUNK_MS = 3000;
/** After a failed start() (auth gone stale, network blip, whatever), wait
 *  this long before trying again -- a caller that calls start() every frame
 *  regardless of outcome must not turn one failure into a request fired many
 *  times per second forever. See startCooldownUntilRef. */
const START_RETRY_COOLDOWN_MS = 30_000;
/** Selectable recording quality. The clinic's own report stills spend ~45 KB
 *  per frame; at the old fixed 1.2 Mbps a video frame got ~5 KB -- a tenth of
 *  the per-frame budget the same signal gets on the clinic's workstation, and
 *  the measured reason saved videos looked so much softer than report images.
 *  8 Mbps matches that still-image budget with a far better codec, so it is
 *  the default; the lower rungs exist for when disk or upload time matters
 *  more than fidelity. Chunks land on disk (OPFS/IndexedDB -- see
 *  chunkStore.ts), so a higher rate costs storage and upload, not memory. */
export const RECORDING_QUALITIES = [
  { key: "standard", bps: 1_200_000, mbPerMin: 9 },
  { key: "high", bps: 4_000_000, mbPerMin: 30 },
  { key: "maximum", bps: 8_000_000, mbPerMin: 60 },
] as const;
export type RecordingQualityKey = (typeof RECORDING_QUALITIES)[number]["key"];
/** The rate is a free number, not one of three rungs: the presets above are
 *  landmarks on the scale (and what the diagnostic sweeps), but the operator
 *  tunes the real one by eye on /sim and the clinic needs to be able to meet
 *  whatever disk and uplink it actually has. */
export const MIN_RECORDING_BPS = 500_000;
export const MAX_RECORDING_BPS = 15_000_000;
const BPS_STORAGE_KEY = "polyp_recording_bps";
const DEFAULT_BPS = 8_000_000;

export function getRecordingBps(): number {
  try {
    const v = Number(localStorage.getItem(BPS_STORAGE_KEY));
    if (Number.isFinite(v) && v >= MIN_RECORDING_BPS && v <= MAX_RECORDING_BPS) return v;
  } catch { /* SSR or storage blocked -- the default is fine */ }
  return DEFAULT_BPS;
}

export function setRecordingBps(bps: number) {
  const clamped = Math.max(MIN_RECORDING_BPS, Math.min(MAX_RECORDING_BPS, Math.round(bps)));
  try { localStorage.setItem(BPS_STORAGE_KEY, String(clamped)); } catch { /* ignore */ }
}

/** Roughly what a minute of video costs at this rate, for the UI to show
 *  before anyone commits a procedure to disk. */
export function mbPerMinute(bps: number): number {
  return Math.round((bps / 8 / 1e6) * 60);
}

/** Read at MediaRecorder creation, not module load: MediaRecorder's bitrate is
 *  fixed for its lifetime, so a change applies when the NEXT recording starts. */
function recordingBitsPerSecond(): number {
  return getRecordingBps();
}

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export type RecorderStatus = "idle" | "starting" | "recording" | "stopping" | "error";

export interface SessionRecorder {
  status: RecorderStatus;
  /** Wall-clock length of the recording in progress, milliseconds. */
  elapsedMs: number;
  /** Milliseconds actually captured, excluding any paused (out-of-body)
   *  stretches. Equal to elapsedMs unless pause()/resume() has been used. */
  recordedMs: number;
  /** False while paused (auto or manual) — no video is being captured right
   *  now, even though status is still "recording". */
  capturing: boolean;
  /** Bytes the server has acknowledged — not bytes handed to MediaRecorder. */
  uploadedBytes: number;
  /** How many chunks the server has acknowledged, and how many this
   *  recording has in total (0 until Stop, once finalize() knows the count).
   *  For a small "N of M uploaded" readout next to the recording controls. */
  uploadedChunks: number;
  totalChunks: number;
  /** Chunks MediaRecorder has handed over but the server has not yet
   *  acknowledged -- unlike totalChunks, this is live from the first
   *  chunk, not just once an upload attempt has surveyed the store. Pairs
   *  with waitingForLink in the UI: pending chunks that aren't currently
   *  held for the live gate are just a slow uplink working through them. */
  pendingChunks: number;
  /** True while a chunk is ready to send but is deliberately being held back
   *  because a live-inference loop is still running somewhere in this tab
   *  (see uploadCoordinator.ts) -- the upload isn't stalled or failed, it's
   *  waiting its turn on purpose. */
  waitingForLink: boolean;
  error: string;
  /** False where the browser has no MediaRecorder (older Safari). */
  supported: boolean;
  /** Which durable backend chunks are being held in before upload. "memory"
   *  means this browser has neither OPFS nor IndexedDB available — a crash
   *  loses everything not yet uploaded, same as before this feature existed. */
  storageKind: ChunkStoreKind | null;
  start: () => Promise<void>;
  /** `reason` is recorded against the recording -- see RecSession.stopReason. */
  stop: (reason?: string) => void;
  /** Pauses capture without ending the session — no data is recorded while
   *  paused. Auto-driven by in-body/out-of-body by default; also callable
   *  directly for a manual override. */
  pause: () => void;
  resume: () => void;
  /** Bumped once a recording finishes, so a list can refresh itself. */
  finishedCount: number;
  /** Where we are in the recording right now — which recording, and how many
   *  ms of actually-recorded (not wall-clock) time in. Null when nothing is
   *  recording. Read live rather than from state so a capture files against
   *  the instant it happened, not the last rendered value. */
  mark: () => { recordingId: string; offsetMs: number } | null;
  /** Save what has been recorded straight to the operator's own disk, with no
   *  network at all. On a link that uploads slower than the camera records,
   *  this is the only way to be sure the video is kept — and it works mid
   *  recording, so a session in progress can always be rescued. */
  downloadLocal: () => void;
  /** Bytes held in local durable storage and downloadable right now. */
  localBytes: number;
}

/** All the state that belongs to ONE recording.
 *
 * This used to be one ref per field, shared by every recording the hook ever
 * made -- which is only safe while recordings never overlap. They do: auto
 * record finalizes a recording once out-of-body persists past its threshold
 * and opens a fresh one the moment the scope is back inside, often seconds
 * later and always while the outgoing recording's finalize() is still
 * awaiting its uploads. start() would then reset the store, the sequence
 * counters and the aborted flag that outgoing finalize() was still using, so
 * its buffered chunks were never sent -- and its store.clear() could delete
 * the NEXT recording's chunks instead of its own. Four of the 2026-09-30
 * clinic recordings are marked complete with a real duration and zero bytes
 * on disk, 200s of one procedure among them. Per-recording state means a
 * finalize can only ever touch its own chunks.
 */
interface RecSession {
  id: string;
  caseId: string;
  mime: string;
  store: ChunkStore | null;
  /** Index of the next chunk MediaRecorder will hand over. */
  seq: number;
  /** How many chunks the server has acknowledged, in order. */
  nextUploadSeq: number;
  /** Serializes this recording's own uploadPending() calls. */
  uploadChain: Promise<void>;
  /** Local-store writes in flight; awaited before the store is read back. */
  pendingWrites: Promise<void>[];
  /** Chunks kept in RAM so downloadLocal() still works after finalize. */
  saved: Blob[];
  aborted: boolean;
  finalized: boolean;
  /** What ended this recording, reported to the server so the next
   *  incident is diagnosable from the metadata instead of by correlating
   *  against server logs. Set by stop() and by the unmount/pagehide
   *  handlers; left undefined when the recorder stopped on its own (camera
   *  unplugged, screen share revoked), which finalize reads as
   *  "tracks-ended". */
  stopReason?: string;
  startedAt: number;
}

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

async function detail(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
  } catch { /* not JSON */ }
  return fallback;
}

export function useSessionRecorder(caseId: string, source: "camera" | "screen" | "replay",
                                   stream: MediaStream | null): SessionRecorder {
  const [status, setStatus]     = useState<RecorderStatus>("idle");
  const [elapsedMs, setElapsed] = useState(0);
  const [recordedMs, setRecordedMs] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [uploadedBytes, setUploaded] = useState(0);
  const [uploadedChunks, setUploadedChunks] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [pendingChunks, setPendingChunks] = useState(0);
  const [waitingForLink, setWaitingForLink] = useState(false);
  const [error, setError]       = useState("");
  const [finishedCount, setFinished] = useState(0);
  const [storageKind, setStorageKind] = useState<ChunkStoreKind | null>(null);

  // start() needs the CURRENT stream even when called through a stale
  // reference (e.g. the auto-record loop in LiveCameraPlayer, whose closure
  // is captured once when the long-running capture loop begins and never
  // updates). Unlike pause()/resume(), start() is not useCallback([])-stable
  // -- it depends on caseId/source/stream and gets a new identity whenever
  // they change -- so a stale copy of it closes over whatever `stream` was
  // at the render it was created from. If that happened to be before the
  // camera stream was ready, every call through that stale reference would
  // see a permanently null stream and silently no-op forever. Reading through
  // a ref, synced below, fixes that the same way every other per-frame flag
  // in the live player is made stale-closure-safe.
  const streamRef = useRef(stream);
  useEffect(() => { streamRef.current = stream; }, [stream]);

  const recorderRef  = useRef<MediaRecorder | null>(null);
  // The recording being written to right now, and the most recent one whether
  // or not it has finished -- downloadLocal() has to keep working after a
  // recording ends, and after a failed upload especially. Per-recording state
  // lives on these objects rather than in a ref each; see RecSession.
  const activeRef    = useRef<RecSession | null>(null);
  const lastRef      = useRef<RecSession | null>(null);
  const startedAtRef = useRef(0);
  // Sum of every "capturing" segment closed so far by a pause(); the current
  // open segment (if any) is added on top of this when read. Lets mark() and
  // the recordedMs readout reflect actually-captured time, excluding any
  // out-of-body stretches, without recomputing history on every read. Only
  // ever describes the active recording -- the only one still capturing.
  const recordedMsRef   = useRef(0);
  const segmentStartRef = useRef(0);
  const capturingRef    = useRef(false);
  // Synchronous re-entrancy guard for start(), set at the very top before any
  // await. activeRef.current alone isn't enough: it's only assigned near the
  // END of start(), after the /start POST round-trips, so two calls fired
  // close together (e.g. the auto-record loop calling start() every frame
  // while it's still inside the body and nothing has been created yet) would
  // both pass that check and race two separate recordings into existence
  // server-side. This closes that window.
  const startingRef  = useRef(false);
  // Backoff after a failed start() -- without this, a caller that retries
  // start() every frame regardless of outcome (LiveCameraPlayer.tsx's
  // auto-record loop does exactly this whenever the scope is inside the
  // body) turns a single persistent failure -- most concretely, a session
  // that's gone stale so every /start POST 401s -- into a request fired many
  // times per second, forever, with a re-render on every single one. That is
  // a real incident, not a hypothetical: it manifested as constant visible
  // "shaking" in a tab whose sign-in had expired while still open.
  const startCooldownUntilRef = useRef(0);
  const [localBytes, setLocalBytes] = useState(0);

  const supported = typeof window !== "undefined" && "MediaRecorder" in window;

  /** Whether the readouts (status, progress, error) should follow this
   *  recording. They describe the recording in progress, so a previous one
   *  still draining its uploads must not write to them -- it would report
   *  "idle" while the next procedure is already recording. Its own progress
   *  stays visible through waitingForLink. */
  const owns = useCallback((sess: RecSession) =>
    activeRef.current === null || activeRef.current === sess, []);

  const putChunk = useCallback(async (sess: RecSession, blob: Blob, seq: number) => {
    if (sess.aborted) return;
    // Yield the link to any live-inference loop running in this tab (e.g. the
    // next procedure already started while this recording was still
    // uploading) before sending. Resolves immediately if nothing is live.
    // waitingForLink is surfaced in the UI so this reads as "waiting its
    // turn on purpose", not as a stalled/broken upload.
    if (isLiveInferenceActive()) setWaitingForLink(true);
    await waitUntilInferenceIdle();
    setWaitingForLink(false);
    if (sess.aborted) return;
    const url = `${API}/api/recordings/${sess.caseId}/${sess.id}/chunk?seq=${seq}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: "PUT", body: blob, credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (owns(sess)) {
            setUploaded(data.bytes ?? 0);
            setUploadedChunks(seq + 1);
            setPendingChunks((n) => Math.max(0, n - 1));
          }
          // Mirrored into the cross-recording registry regardless of owns():
          // once this recording is in the registry (finalize() put it there),
          // it needs updating whether or not a component still owns it.
          updateUpload(sess.id, { uploadedBytes: data.bytes ?? 0, uploadedChunks: seq + 1 });
          // "closing" is the server's normal status the instant a recording
          // ends -- set deliberately so append_chunk keeps accepting the
          // backlog (see backend/routes/recordings.py's stop_recording). Only
          // "truncated" (the server actually refused a chunk for hitting its
          // size cap) is a real error. Checking "!== recording" here instead
          // of "=== truncated" was the Aban 6 2026-10-28 incident: every
          // recording's own end sets "closing" moments before its backlog
          // starts draining, so the FIRST backlog chunk to upload after that
          // always tripped this check and killed the rest of the upload --
          // one chunk landing, every time, regardless of capture hardware.
          if (data.status === "truncated") {
            sess.aborted = true;
            if (owns(sess)) setError("recording reached the server's size limit and was closed");
            // Only the recording still being captured has a MediaRecorder to
            // stop -- stopping it on behalf of an older session would cut the
            // procedure that is actually running.
            if (activeRef.current === sess) {
              try { recorderRef.current?.stop(); } catch { /* already stopped */ }
            }
          }
          return;
        }
        // A 4xx is a decision, not a hiccup -- retrying it just loses time.
        if (res.status < 500) throw new Error(await detail(res, `upload failed (${res.status})`));
      } catch (err) {
        if (attempt === 1) {
          sess.aborted = true;
          if (owns(sess)) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus("error");
          }
          if (activeRef.current === sess) {
            try { recorderRef.current?.stop(); } catch { /* already stopped */ }
          }
          return;
        }
      }
    }
  }, [owns]);

  /** Uploads whatever of THIS recording is in durable storage and hasn't been
   *  sent yet, advancing sess.nextUploadSeq as it goes. Called both by
   *  pause() (an opportunistic trickle -- the out-of-body stretch that just
   *  started is probably a genuinely free link, see LiveCameraPlayer.tsx) and
   *  by finalize() (drain whatever's left at Stop). Safe to call either way,
   *  any number of times, since it always resumes from where the last call
   *  actually got to -- putChunk's own waitUntilInferenceIdle gate is what
   *  decides whether a given chunk can send right now, not this function. */
  const uploadPending = useCallback((sess: RecSession): Promise<void> => {
    const run = async () => {
      if (sess.aborted || !sess.store) return;
      // Ordering requirement: the last chunk's local write may still be
      // settling when a pause fires right after it.
      await Promise.all(sess.pendingWrites);
      const buffered = await sess.store.readAll();
      if (owns(sess)) setTotalChunks(buffered.length);
      updateUpload(sess.id, {
        totalChunks: buffered.length,
        totalBytesEstimate: buffered.reduce((a, b) => a + b.size, 0),
      });
      for (let i = sess.nextUploadSeq; i < buffered.length && !sess.aborted; i++) {
        await putChunk(sess, buffered[i], i);
        sess.nextUploadSeq = i + 1;
      }
    };
    // .then(run, run): keep the chain alive even if a previous link somehow
    // rejected, rather than every later call silently never running.
    sess.uploadChain = sess.uploadChain.then(run, run);
    return sess.uploadChain;
  }, [putChunk, owns]);

  /** Runs on MediaRecorder's onstop -- however that came about. The tracks
   *  ending (camera unplugged, screen share revoked) stops the recorder
   *  without anyone calling stop(), and that recording still has to be closed
   *  on the server or it sits in the list marked "recording" forever. */
  const finalize = useCallback(async (sess: RecSession, durationMs: number) => {
    if (sess.finalized) return;
    sess.finalized = true;
    // Released before the awaits below: this recording is no longer the one
    // being captured, so a start() firing while it drains is legitimate and
    // must not be blocked -- it just gets its own RecSession.
    if (activeRef.current === sess) {
      activeRef.current = null;
      recorderRef.current = null;
    }

    if (owns(sess)) setStatus("stopping");
    const reason = sess.stopReason ?? "tracks-ended";
    const markStopped = async (closing: boolean) => {
      try {
        const body = new FormData();
        body.append("duration_ms", String(Math.round(durationMs)));
        body.append("stop_reason", reason);
        if (closing) body.append("closing", "true");
        await fetch(`${API}/api/recordings/${sess.caseId}/${sess.id}/stop`,
                    { method: "POST", body, credentials: "include" });
      } catch { /* the bytes are on disk either way; the stale sweep finalizes it */ }
    };
    // Mark it finished FIRST -- before the drain below, not after.
    //
    // The drain is deliberately deprioritised behind live inference (see
    // putChunk) and can run for many minutes, and until the server has this
    // mark the recording carries no duration, so every picker filters it
    // out. On 2026-10-21 a recording trickled for 11m48s after it had
    // already ended; the tab closed one second after its last chunk landed,
    // and the single stop call that used to live only at the END of this
    // function never went out. Six recordings across two clinic days --
    // 29.5 minutes of footage -- sat unlistable with every byte uploaded.
    //
    // "closing" is what keeps the server accepting the rest of the chunks;
    // a plain stop would 409 them, and putChunk treats a 4xx as fatal.
    await markStopped(true);

    // From here on this recording is a background upload job that may
    // outlive the component that started it -- register it in the
    // cross-recording registry (see uploadRegistry.ts) before the drain
    // below so "how many videos are still uploading" is answerable from the
    // moment that becomes true, not just while this hook instance happens
    // to still be mounted.
    const knownSoFar = sess.store ? await sess.store.readAll().catch(() => []) : [];
    registerUpload(sess.id, sess.caseId, knownSoFar.reduce((a, b) => a + b.size, 0));

    // Most of this recording may already be on the server -- pause() fires an
    // opportunistic trickle upload during every out-of-body stretch (see
    // LiveCameraPlayer.tsx), so this just drains whatever's left, resuming
    // from sess.nextUploadSeq rather than re-sending from the start. Each
    // chunk itself still waits its own turn behind any live inference the
    // NEXT procedure has already started -- see putChunk.
    await uploadPending(sess);
    // saved needs the full list (for downloadLocal), not just whatever
    // uploadPending's own internal read happened to see -- read it again
    // here; cheap, and guarantees completeness regardless of trickle timing.
    sess.saved = sess.store ? await sess.store.readAll() : [];
    // Everything has landed: flip "closing" to "complete".
    await markStopped(false);
    // Once every chunk has reached the server, the local durable copy has
    // done its job -- clear it so a normal, successful session doesn't show up
    // in the next page load's orphan-recovery scan. A failed/aborted session
    // deliberately keeps its local copy so that scan can offer to recover it.
    if (!sess.aborted) { await sess.store?.clear().catch(() => {}); }
    finishUpload(sess.id);
    if (owns(sess)) {
      setStatus(sess.aborted ? "error" : "idle");
      setElapsed(0);
    }
    setFinished((n) => n + 1);
  }, [uploadPending, owns]);

  const start = useCallback(async () => {
    // Shadows the outer `stream` param on purpose: reading through the ref
    // means even a call made through a stale copy of this function (its
    // identity changes whenever caseId/source/stream change, unlike
    // pause()/resume()) sees the CURRENT stream, not whatever it was at the
    // render this particular closure was created from. See streamRef's
    // comment above.
    const stream = streamRef.current;
    if (!stream || activeRef.current || startingRef.current) return;
    if (Date.now() < startCooldownUntilRef.current) return;
    startingRef.current = true;
    try {
    const mimeType = pickMimeType();
    if (!mimeType) {
      setError("This browser cannot record video (MediaRecorder is unavailable).");
      setStatus("error");
      startCooldownUntilRef.current = Date.now() + START_RETRY_COOLDOWN_MS;
      return;
    }

    setStatus("starting");
    setError("");
    setUploaded(0);
    setUploadedChunks(0);
    setTotalChunks(0);
    setPendingChunks(0);
    setWaitingForLink(false);
    setStorageKind(null);
    setLocalBytes(0);

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};

    let recordingId: string;
    try {
      const body = new FormData();
      body.append("source", source);
      body.append("mime", mimeType);
      body.append("width", String(settings.width ?? 0));
      body.append("height", String(settings.height ?? 0));
      const res = await fetch(`${API}/api/recordings/${caseId}/start`,
                              { method: "POST", body, credentials: "include" });
      if (!res.ok) throw new Error(await detail(res, `could not start recording (${res.status})`));
      recordingId = (await res.json()).recording_id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      // This is the path a stale/expired sign-in takes (the server 401s the
      // POST) -- without a cooldown, a caller that retries every frame (the
      // auto-record loop does) turns that into a request fired many times a
      // second, forever, with a re-render on every one. Real incident, not
      // hypothetical: this is what caused the "constant shaking" report.
      startCooldownUntilRef.current = Date.now() + START_RETRY_COOLDOWN_MS;
      return;
    }

    // Everything this recording owns, created before anything can write to it
    // and never shared with the next one -- see RecSession. The case is
    // captured here too: the stop POST needs the case the recording was
    // OPENED under, not whatever the page has moved on to by then.
    const sess: RecSession = {
      id: recordingId,
      caseId,
      mime: mimeType,
      store: null,
      seq: 0,
      nextUploadSeq: 0,
      uploadChain: Promise.resolve(),
      pendingWrites: [],
      saved: [],
      aborted: false,
      finalized: false,
      startedAt: 0,
    };
    lastRef.current = sess;

    // Never rejects -- falls back OPFS -> IndexedDB -> memory on its own.
    sess.store = await openChunkStore(caseId, recordingId);
    setStorageKind(sess.store.kind);

    try {
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: recordingBitsPerSecond() });
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || sess.aborted) return;
        const seq = sess.seq++;
        if (owns(sess)) setPendingChunks((n) => n + 1);
        const write = sess.store
          ? sess.store.append(e.data, seq).catch((err) => {
              // A single failed local write must not stop the recording -- it's
              // tracked below regardless, so finalize() still waits for this
              // attempt to settle before deciding what actually landed.
              console.error("[recorder] failed to persist chunk locally", err);
            })
          : Promise.resolve();
        sess.pendingWrites.push(write);
        setLocalBytes((n) => n + e.data.size);
      };
      recorder.onstop = () => { void finalize(sess, Date.now() - sess.startedAt); };
      const now = Date.now();
      sess.startedAt = now;
      startedAtRef.current = now;
      segmentStartRef.current = now;
      recordedMsRef.current = 0;
      capturingRef.current = true;
      setCapturing(true);
      setRecordedMs(0);
      recorder.start(CHUNK_MS);
      recorderRef.current = recorder;
      activeRef.current = sess;
      setElapsed(0);
      setStatus("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      startCooldownUntilRef.current = Date.now() + START_RETRY_COOLDOWN_MS;
      void finalize(sess, 0);
    }
    } finally {
      startingRef.current = false;
    }
  }, [caseId, source, finalize]);

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    recordedMsRef.current += Date.now() - segmentStartRef.current;
    capturingRef.current = false;
    setCapturing(false);
    try { rec.pause(); } catch { /* already not recording */ }
    // Opportunistic trickle: this pause is very possibly an out-of-body
    // stretch, during which the live-inference loop isn't sending frames at
    // all (see LiveCameraPlayer.tsx's applyAutoRecord) -- the link is
    // genuinely free right now, not just "eventually, at Stop". Fire-and-
    // forget: if frames resume before this gets far, putChunk's own
    // waitUntilInferenceIdle gate holds the next chunk rather than competing.
    const sess = activeRef.current;
    if (sess) void uploadPending(sess);
  }, [uploadPending]);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    segmentStartRef.current = Date.now();
    capturingRef.current = true;
    setCapturing(true);
    try { rec.resume(); } catch { /* already recording */ }
  }, []);

  const downloadLocal = useCallback(() => {
    const sess = lastRef.current;
    if (!sess) return;
    void (async () => {
      let chunks = sess.saved;
      if (chunks.length === 0 && sess.store) {
        // Mid-recording, `saved` is still empty -- it is only filled by
        // finalize(). This used to mean the button silently did nothing for
        // the entire procedure, while RecordingControls offered it as soon as
        // localBytes > 0 and the doc comment promised it worked mid
        // recording. On a link that uploads slower than the camera records,
        // this is the operator's only way to keep the video.
        await Promise.all(sess.pendingWrites);
        chunks = await sess.store.readAll().catch(() => []);
      }
      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: sess.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `noormind-${sess.caseId}-${sess.id}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })();
  }, []);

  const mark = useCallback(() => {
    const sess = activeRef.current;
    if (!sess || !startedAtRef.current) return null;
    // Actually-recorded time, not wall clock: if any out-of-body pause has
    // happened, the recorded video is shorter than elapsed time, and an
    // offset computed from the wall clock would point at the wrong moment.
    const openSegment = capturingRef.current ? Date.now() - segmentStartRef.current : 0;
    return { recordingId: sess.id, offsetMs: recordedMsRef.current + openSegment };
  }, []);

  const stop = useCallback((reason: string = "manual") => {
    const recorder = recorderRef.current;
    const sess = activeRef.current;
    if (!recorder || !sess) return;
    sess.stopReason = reason;
    setStatus("stopping");
    try {
      // Flushes the partial slice as one last ondataavailable, then fires onstop.
      if (recorder.state !== "inactive") recorder.stop();
      else void finalize(sess, Date.now() - sess.startedAt);
    } catch {
      void finalize(sess, Date.now() - sess.startedAt);
    }
  }, [finalize]);

  // Elapsed/recorded clocks, driven off the real start time rather than
  // accumulated ticks so a throttled background tab doesn't under-report the
  // length. recordedMs stays behind elapsedMs by however long the recorder
  // has spent paused so far — that gap is expected, not a bug.
  useEffect(() => {
    if (status !== "recording") return;
    const id = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
      const openSegment = capturingRef.current ? Date.now() - segmentStartRef.current : 0;
      setRecordedMs(recordedMsRef.current + openSegment);
    }, 500);
    return () => clearInterval(id);
  }, [status]);

  // Leaving the page mid-procedure would end the recording wherever it got to.
  // Whatever reached the server is still playable, but the operator should be
  // told before it happens, not after.
  useEffect(() => {
    if (status !== "recording") return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    // beforeunload can only ASK; it cannot reliably send. pagehide is what
    // fires on an actual tab close, and sendBeacon is the only request that
    // survives it -- a normal fetch is cancelled along with the page. Without
    // this, closing the tab left the recording stuck at "recording" with no
    // duration and invisible to every picker: exactly how 2026-10-21 lost
    // three videos. duration_ms here is wall clock, because the page is going
    // away and there is no time to measure anything better; the stale sweep
    // (backend/scripts/finalize_stale_recordings.py) corrects it off the file.
    const flush = () => {
      const sess = activeRef.current;
      if (!sess || sess.finalized) return;
      const body = new FormData();
      body.append("duration_ms", String(Math.round(Date.now() - sess.startedAt)));
      body.append("stop_reason", "tab-closed");
      body.append("closing", "true");
      try {
        navigator.sendBeacon(`${API}/api/recordings/${sess.caseId}/${sess.id}/stop`, body);
      } catch { /* nothing left to try at this point */ }
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", flush);
    };
  }, [status]);

  // Unmount (navigating out of the live mode) closes the recording cleanly.
  // Without this the server keeps it open and it lists as interrupted.
  useEffect(() => () => {
    const recorder = recorderRef.current;
    const sess = activeRef.current;
    if (sess && !sess.stopReason) sess.stopReason = "unmount";
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
  }, []);

  return { status, elapsedMs, recordedMs, capturing, uploadedBytes, uploadedChunks, totalChunks,
           pendingChunks, waitingForLink, error, supported,
           storageKind, start, stop, pause, resume,
           finishedCount, mark, downloadLocal, localBytes };
}
