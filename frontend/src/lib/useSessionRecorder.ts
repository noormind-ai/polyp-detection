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

const API = process.env.NEXT_PUBLIC_API_URL || "";

/** How much video each upload carries. Short enough that a crash loses little,
 *  long enough that a 40-minute procedure is ~800 requests, not ~24,000. */
const CHUNK_MS = 3000;
/** ~9 MB/minute. Chunks are now held until the session ends, so this is what
 *  the browser buffers in memory as well as what lands on disk. 720p endoscopy
 *  still reads clearly at this rate. */
const VIDEO_BITS_PER_SECOND = 1_200_000;

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
  stop: () => void;
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

function pickMimeType(): string | null {
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

export function useSessionRecorder(caseId: string, source: "camera" | "screen",
                                   stream: MediaStream | null): SessionRecorder {
  const [status, setStatus]     = useState<RecorderStatus>("idle");
  const [elapsedMs, setElapsed] = useState(0);
  const [recordedMs, setRecordedMs] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [uploadedBytes, setUploaded] = useState(0);
  const [uploadedChunks, setUploadedChunks] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
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
  const idRef        = useRef<string | null>(null);
  const seqRef       = useRef(0);
  const startedAtRef = useRef(0);
  // Sum of every "capturing" segment closed so far by a pause(); the current
  // open segment (if any) is added on top of this when read. Lets mark() and
  // the recordedMs readout reflect actually-captured time, excluding any
  // out-of-body stretches, without recomputing history on every read.
  const recordedMsRef   = useRef(0);
  const segmentStartRef = useRef(0);
  const capturingRef    = useRef(false);
  // Synchronous re-entrancy guard for start(), set at the very top before any
  // await. recorderRef.current alone isn't enough: it's only assigned near
  // the END of start(), after the /start POST round-trips, so two calls fired
  // close together (e.g. the auto-record loop calling start() every frame
  // while it's still inside the body and nothing has been created yet) would
  // both pass the recorderRef check and race two separate recordings into
  // existence server-side. This closes that window; recorderRef.current
  // takes back over as the guard once a recording actually exists.
  const startingRef  = useRef(false);
  // Durable local store for this recording's chunks — see chunkStore.ts.
  // Replaces a plain in-memory array so a crash loses at most the last
  // unflushed chunk instead of the whole procedure.
  const storeRef     = useRef<ChunkStore | null>(null);
  // Every append() promise, so finalize() can wait for all of them before
  // reading the store back. ondataavailable fires-and-forgets its write (it
  // must not block MediaRecorder's own callback), but `stop()`'s onstop fires
  // right after the LAST ondataavailable -- without this, finalize() could
  // call store.readAll() before that last write (or even an earlier one) has
  // actually landed, silently uploading a truncated or empty recording.
  const pendingWritesRef = useRef<Promise<void>[]>([]);
  // Survives finalize() so the operator can still save a local copy after the
  // upload has run — or after it has failed. Kept in RAM deliberately: by the
  // time finalize() reads these out of the durable store, holding them in
  // memory too costs nothing extra and keeps downloadLocal() synchronous.
  const savedRef     = useRef<Blob[]>([]);
  // How many chunks (by count, since uploadPending always sends them in
  // order) the server has already acknowledged -- shared between the
  // trickle-upload triggered by pause() and the final drain in finalize(), so
  // neither re-sends what the other already delivered.
  const nextUploadSeqRef = useRef(0);
  // Every uploadPending() call is chained onto this so overlapping calls
  // (a trickle still running when Stop is pressed, or two pauses close
  // together) queue instead of racing the same store/sequence counter.
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
  const mimeRef      = useRef<string>("video/webm");
  const [localBytes, setLocalBytes] = useState(0);
  const abortedRef   = useRef(false);
  const finalizedRef = useRef(false);
  // The stop POST needs the case the recording was OPENED under. Reading state
  // at stop time would use whatever case the page has moved on to.
  const caseRef      = useRef(caseId);

  const supported = typeof window !== "undefined" && "MediaRecorder" in window;

  const putChunk = useCallback(async (blob: Blob, seq: number, recId: string) => {
    if (abortedRef.current || !recId) return;
    // Yield the link to any live-inference loop running in this tab (e.g. the
    // next procedure already started while this recording was still
    // uploading) before sending. Resolves immediately if nothing is live.
    // waitingForLink is surfaced in the UI so this reads as "waiting its
    // turn on purpose", not as a stalled/broken upload.
    if (isLiveInferenceActive()) setWaitingForLink(true);
    await waitUntilInferenceIdle();
    setWaitingForLink(false);
    if (abortedRef.current) return;
    const url = `${API}/api/recordings/${caseRef.current}/${recId}/chunk?seq=${seq}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: "PUT", body: blob, credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setUploaded(data.bytes ?? 0);
          setUploadedChunks(seq + 1);
          // The server closes a recording that hits its size cap; keep
          // uploading into it and every later chunk 409s.
          if (data.status && data.status !== "recording") {
            abortedRef.current = true;
            setError("recording reached the server's size limit and was closed");
            try { recorderRef.current?.stop(); } catch { /* already stopped */ }
          }
          return;
        }
        // A 4xx is a decision, not a hiccup — retrying it just loses time.
        if (res.status < 500) throw new Error(await detail(res, `upload failed (${res.status})`));
      } catch (err) {
        if (attempt === 1) {
          abortedRef.current = true;
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
          try { recorderRef.current?.stop(); } catch { /* already stopped */ }
          return;
        }
      }
    }
  }, []);

  /** Uploads whatever's currently in durable storage that hasn't been sent
   *  yet, advancing nextUploadSeqRef as it goes. Called both by pause() (an
   *  opportunistic trickle -- the out-of-body stretch that just started is
   *  probably a genuinely free link, see LiveCameraPlayer.tsx) and by
   *  finalize() (drain whatever's left at Stop). Safe to call either way,
   *  any number of times, since it always resumes from where the last call
   *  actually got to -- putChunk's own waitUntilInferenceIdle gate is what
   *  decides whether a given chunk can send right now, not this function. */
  const uploadPending = useCallback((id: string): Promise<void> => {
    const run = async () => {
      if (abortedRef.current) return;
      const store = storeRef.current;
      if (!store) return;
      // Same ordering requirement as finalize() used to enforce alone: the
      // last chunk's local write may still be settling when a pause fires
      // right after it.
      await Promise.all(pendingWritesRef.current);
      const buffered = await store.readAll();
      setTotalChunks(buffered.length);
      for (let i = nextUploadSeqRef.current; i < buffered.length && !abortedRef.current; i++) {
        await putChunk(buffered[i], i, id);
        nextUploadSeqRef.current = i + 1;
      }
    };
    // .then(run, run): keep the chain alive even if a previous link somehow
    // rejected, rather than every later call silently never running.
    uploadChainRef.current = uploadChainRef.current.then(run, run);
    return uploadChainRef.current;
  }, [putChunk]);

  /** Runs on MediaRecorder's onstop — however that came about. The tracks
   *  ending (camera unplugged, screen share revoked) stops the recorder
   *  without anyone calling stop(), and that recording still has to be closed
   *  on the server or it sits in the list marked "recording" forever. */
  const finalize = useCallback(async (durationMs: number) => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    const id = idRef.current;
    idRef.current = null;
    recorderRef.current = null;
    if (!id) { setStatus("idle"); return; }

    setStatus("stopping");
    // Most of this recording may already be on the server -- pause() fires an
    // opportunistic trickle upload during every out-of-body stretch (see
    // LiveCameraPlayer.tsx), so this just drains whatever's left, resuming
    // from nextUploadSeqRef rather than re-sending from the start. Each chunk
    // itself still waits its own turn behind any live inference the NEXT
    // procedure has already started -- see putChunk.
    const store = storeRef.current;
    await uploadPending(id);
    // savedRef needs the full list (for downloadLocal), not just whatever
    // uploadPending's own internal read happened to see -- read it again
    // here; cheap, and guarantees completeness regardless of trickle timing.
    savedRef.current = store ? await store.readAll() : [];
    try {
      const body = new FormData();
      body.append("duration_ms", String(Math.round(durationMs)));
      await fetch(`${API}/api/recordings/${caseRef.current}/${id}/stop`,
                  { method: "POST", body, credentials: "include" });
    } catch { /* the recording is on disk either way; it just shows as interrupted */ }
    // Once every chunk has reached the server, the local durable copy has
    // done its job — clear it so a normal, successful session doesn't show up
    // in the next page load's orphan-recovery scan. A failed/aborted session
    // deliberately keeps its local copy so that scan can offer to recover it.
    if (!abortedRef.current) { await store?.clear().catch(() => {}); }
    setStatus(abortedRef.current ? "error" : "idle");
    setElapsed(0);
    setFinished((n) => n + 1);
  }, [uploadPending]);

  const start = useCallback(async () => {
    // Shadows the outer `stream` param on purpose: reading through the ref
    // means even a call made through a stale copy of this function (its
    // identity changes whenever caseId/source/stream change, unlike
    // pause()/resume()) sees the CURRENT stream, not whatever it was at the
    // render this particular closure was created from. See streamRef's
    // comment above.
    const stream = streamRef.current;
    if (!stream || recorderRef.current || startingRef.current) return;
    startingRef.current = true;
    try {
    const mimeType = pickMimeType();
    if (!mimeType) {
      setError("This browser cannot record video (MediaRecorder is unavailable).");
      setStatus("error");
      return;
    }

    setStatus("starting");
    setError("");
    setUploaded(0);
    setUploadedChunks(0);
    setTotalChunks(0);
    setWaitingForLink(false);
    abortedRef.current = false;
    finalizedRef.current = false;
    pendingWritesRef.current = [];
    seqRef.current = 0;
    nextUploadSeqRef.current = 0;
    uploadChainRef.current = Promise.resolve();
    savedRef.current = [];
    storeRef.current = null;
    setStorageKind(null);
    setLocalBytes(0);
    caseRef.current = caseId;

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
      idRef.current = recordingId;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      return;
    }

    // Never rejects — falls back OPFS -> IndexedDB -> memory on its own.
    const store = await openChunkStore(caseId, recordingId);
    storeRef.current = store;
    setStorageKind(store.kind);

    try {
      mimeRef.current = mimeType;
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || abortedRef.current) return;
        const seq = seqRef.current++;
        const store = storeRef.current;
        const write = store
          ? store.append(e.data, seq).catch((err) => {
              // A single failed local write must not stop the recording — it's
              // tracked below regardless, so finalize() still waits for this
              // attempt to settle before deciding what actually landed.
              console.error("[recorder] failed to persist chunk locally", err);
            })
          : Promise.resolve();
        pendingWritesRef.current.push(write);
        setLocalBytes((n) => n + e.data.size);
      };
      recorder.onstop = () => { void finalize(Date.now() - startedAtRef.current); };
      const now = Date.now();
      startedAtRef.current = now;
      segmentStartRef.current = now;
      recordedMsRef.current = 0;
      capturingRef.current = true;
      setCapturing(true);
      setRecordedMs(0);
      recorder.start(CHUNK_MS);
      recorderRef.current = recorder;
      setElapsed(0);
      setStatus("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      void finalize(0);
    }
    } finally {
      startingRef.current = false;
    }
  }, [caseId, source, stream, putChunk, finalize]);

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
    const id = idRef.current;
    if (id) void uploadPending(id);
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
    const chunks = savedRef.current;
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mimeRef.current });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `noormind-${caseRef.current}-${idRef.current ?? "session"}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  const mark = useCallback(() => {
    if (!idRef.current || !startedAtRef.current) return null;
    // Actually-recorded time, not wall clock: if any out-of-body pause has
    // happened, the recorded video is shorter than elapsed time, and an
    // offset computed from the wall clock would point at the wrong moment.
    const openSegment = capturingRef.current ? Date.now() - segmentStartRef.current : 0;
    return { recordingId: idRef.current, offsetMs: recordedMsRef.current + openSegment };
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setStatus("stopping");
    try {
      // Flushes the partial slice as one last ondataavailable, then fires onstop.
      if (recorder.state !== "inactive") recorder.stop();
      else void finalize(Date.now() - startedAtRef.current);
    } catch {
      void finalize(Date.now() - startedAtRef.current);
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
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  // Unmount (navigating out of the live mode) closes the recording cleanly.
  // Without this the server keeps it open and it lists as interrupted.
  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
  }, []);

  return { status, elapsedMs, recordedMs, capturing, uploadedBytes, uploadedChunks, totalChunks,
           waitingForLink, error, supported,
           storageKind, start, stop, pause, resume,
           finishedCount, mark, downloadLocal, localBytes };
}
