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
 * Chunks upload as they are produced, strictly one at a time. Two reasons for
 * the sequencing: a WebM is only valid if its clusters are concatenated in
 * order, and the server refuses an out-of-order `seq` outright — so parallel
 * uploads would not race into a corrupt file, they would simply fail. A chunk
 * that cannot be delivered after a retry stops the recording rather than
 * leaving a hole in the middle of a video that still looks fine in the list.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

/** How much video each upload carries. Short enough that a crash loses little,
 *  long enough that a 40-minute procedure is ~800 requests, not ~24,000. */
const CHUNK_MS = 3000;
/** ~19 MB/minute. Plenty for 720p endoscopy video, and it keeps an hour-long
 *  procedure near 1 GB instead of several. */
const VIDEO_BITS_PER_SECOND = 2_500_000;

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
  /** Bytes the server has acknowledged — not bytes handed to MediaRecorder. */
  uploadedBytes: number;
  error: string;
  /** False where the browser has no MediaRecorder (older Safari). */
  supported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  /** Bumped once a recording finishes, so a list can refresh itself. */
  finishedCount: number;
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
  const [uploadedBytes, setUploaded] = useState(0);
  const [error, setError]       = useState("");
  const [finishedCount, setFinished] = useState(0);

  const recorderRef  = useRef<MediaRecorder | null>(null);
  const idRef        = useRef<string | null>(null);
  const seqRef       = useRef(0);
  const startedAtRef = useRef(0);
  // Uploads are chained onto this so exactly one is ever in flight.
  const queueRef     = useRef<Promise<void>>(Promise.resolve());
  const abortedRef   = useRef(false);
  const finalizedRef = useRef(false);
  // The stop POST needs the case the recording was OPENED under. Reading state
  // at stop time would use whatever case the page has moved on to.
  const caseRef      = useRef(caseId);

  const supported = typeof window !== "undefined" && "MediaRecorder" in window;

  const putChunk = useCallback(async (blob: Blob, seq: number) => {
    if (abortedRef.current || !idRef.current) return;
    const url = `${API}/api/recordings/${caseRef.current}/${idRef.current}/chunk?seq=${seq}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: "PUT", body: blob, credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setUploaded(data.bytes ?? 0);
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
    await queueRef.current;          // let every pending chunk land first
    try {
      const body = new FormData();
      body.append("duration_ms", String(Math.round(durationMs)));
      await fetch(`${API}/api/recordings/${caseRef.current}/${id}/stop`,
                  { method: "POST", body, credentials: "include" });
    } catch { /* the recording is on disk either way; it just shows as interrupted */ }
    setStatus(abortedRef.current ? "error" : "idle");
    setElapsed(0);
    setFinished((n) => n + 1);
  }, []);

  const start = useCallback(async () => {
    if (!stream || recorderRef.current) return;
    const mimeType = pickMimeType();
    if (!mimeType) {
      setError("This browser cannot record video (MediaRecorder is unavailable).");
      setStatus("error");
      return;
    }

    setStatus("starting");
    setError("");
    setUploaded(0);
    abortedRef.current = false;
    finalizedRef.current = false;
    seqRef.current = 0;
    queueRef.current = Promise.resolve();
    caseRef.current = caseId;

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};

    try {
      const body = new FormData();
      body.append("source", source);
      body.append("mime", mimeType);
      body.append("width", String(settings.width ?? 0));
      body.append("height", String(settings.height ?? 0));
      const res = await fetch(`${API}/api/recordings/${caseId}/start`,
                              { method: "POST", body, credentials: "include" });
      if (!res.ok) throw new Error(await detail(res, `could not start recording (${res.status})`));
      idRef.current = (await res.json()).recording_id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      return;
    }

    try {
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || abortedRef.current) return;
        const seq = seqRef.current++;
        queueRef.current = queueRef.current.then(() => putChunk(e.data, seq));
      };
      recorder.onstop = () => { void finalize(Date.now() - startedAtRef.current); };
      startedAtRef.current = Date.now();
      recorder.start(CHUNK_MS);
      recorderRef.current = recorder;
      setElapsed(0);
      setStatus("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      void finalize(0);
    }
  }, [caseId, source, stream, putChunk, finalize]);

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

  // Elapsed clock, driven off the real start time rather than accumulated
  // ticks so a throttled background tab doesn't under-report the length.
  useEffect(() => {
    if (status !== "recording") return;
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 500);
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

  return { status, elapsedMs, uploadedBytes, error, supported, start, stop, finishedCount };
}
