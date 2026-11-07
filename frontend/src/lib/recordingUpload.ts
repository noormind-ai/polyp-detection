"use client";

/**
 * Chunk-upload mechanics shared by two callers: a live recording
 * (useSessionRecorder.ts, draining as it goes / at Stop) and resuming an
 * orphaned recording left behind by a crashed tab (RecordingRecoveryBanner.tsx).
 * One implementation of "how a chunk reaches the server" instead of two that
 * can drift apart.
 *
 * Deliberately does NOT wait on the bandwidth-arbitration gate
 * (uploadCoordinator.ts) itself -- each caller has its own notion of what to
 * re-check once the wait is over (a live session re-checks sess.aborted; the
 * orphan drain has nothing equivalent to re-check), so each caller calls
 * waitUntilInferenceIdle() on its own before reaching into this file. This
 * file is pure "PUT one chunk, retry once" mechanics.
 */

import { readOrphanBlobs, forgetRecording } from "./chunkStore";
import { waitUntilInferenceIdle, isLiveInferenceActive } from "./uploadCoordinator";

const API = process.env.NEXT_PUBLIC_API_URL || "";

// Mirrors CHUNK_MS in useSessionRecorder.ts -- not imported from there to
// avoid a circular module dependency (that file imports from this one).
// Only used as a rough duration estimate below; keep the two in sync if
// MediaRecorder's timeslice ever changes.
const APPROX_CHUNK_MS = 3000;

export interface ChunkUploadResult {
  bytes: number;
  chunks: number;
  status: string;
}

async function detail(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
  } catch { /* not JSON */ }
  return fallback;
}

/** PUTs one chunk to /api/recordings/{caseId}/{recordingId}/chunk. Retries
 *  once on failure: a 4xx throws straight into that retry (the server's own
 *  comment in recordings.py frames this as "a decision, not a hiccup", but a
 *  transient misread right after a reconnect shouldn't be instantly fatal
 *  either); a 5xx is retried silently with no exception -- matches the
 *  behavior this was extracted from. Throws after a second failure. */
export async function uploadChunkToServer(
  caseId: string,
  recordingId: string,
  blob: Blob,
  seq: number,
  opts?: { onRetry?: () => void },
): Promise<ChunkUploadResult> {
  const url = `${API}/api/recordings/${caseId}/${recordingId}/chunk?seq=${seq}`;
  let lastErr: unknown = new Error("upload failed");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: blob, credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        return { bytes: data.bytes ?? 0, chunks: seq + 1, status: data.status ?? "recording" };
      }
      if (res.status < 500) throw new Error(await detail(res, `upload failed (${res.status})`));
      // A 5xx falls through to the next attempt with no exception -- the
      // same thing the inlined version this came from did.
    } catch (err) {
      lastErr = err;
      if (attempt === 1) throw err instanceof Error ? err : new Error(String(err));
      opts?.onRetry?.();
    }
  }
  // Only reached if every attempt hit a silent 5xx with no exception thrown.
  // Surfacing that as a thrown error (instead of quietly returning, which is
  // what the function this replaced did in this exact corner) is a small,
  // deliberate improvement made in passing -- a caller now always either gets
  // a real result or finds out it didn't.
  throw lastErr instanceof Error ? lastErr : new Error("upload failed");
}

export interface DrainProgress {
  uploadedChunks: number;
  totalChunks: number;
}

/** Finishes uploading a recording that a crashed/closed tab left behind in
 *  local durable storage (see chunkStore.ts), driven from
 *  RecordingRecoveryBanner.tsx rather than a live useSessionRecorder
 *  instance. Asks the server how much of this recording it already has
 *  (append_chunk is idempotent-by-seq, so re-sending from 0 would just 409 on
 *  every chunk it already holds) and resumes from there. Still goes through
 *  the same bandwidth-arbitration gate as a live recording's own uploads, so
 *  finishing yesterday's orphan can never compete with a procedure running
 *  right now in this same tab. */
export async function drainOrphanToServer(
  caseId: string,
  recordingId: string,
  onProgress?: (p: DrainProgress) => void,
): Promise<void> {
  const listRes = await fetch(
    `${API}/api/recordings?case_id=${encodeURIComponent(caseId)}`,
    { credentials: "include" },
  );
  if (!listRes.ok) throw new Error(`could not check recording status (${listRes.status})`);
  const serverList: { id: string; chunks?: number; status: string }[] = await listRes.json();
  const match = serverList.find((r) => r.id === recordingId);
  if (!match) throw new Error("server has never heard of this recording");
  // Already landed -- nothing to do. The banner itself already filters these
  // out before offering a recovery action, but this guards direct reuse.
  if (match.status === "complete" || match.status === "truncated") return;

  const found = await readOrphanBlobs(recordingId);
  if (!found || found.blobs.length === 0) throw new Error("no local chunks to upload");

  const startSeq = match.chunks ?? 0;
  const total = found.blobs.length;
  for (let seq = startSeq; seq < total; seq++) {
    if (isLiveInferenceActive()) onProgress?.({ uploadedChunks: seq, totalChunks: total });
    await waitUntilInferenceIdle();
    await uploadChunkToServer(caseId, recordingId, found.blobs[seq], seq);
    onProgress?.({ uploadedChunks: seq + 1, totalChunks: total });
  }

  // Duration was never measured for an orphan (the tab never got to call
  // stop()) -- estimate it off the chunk count. Close enough: the stale sweep
  // (backend/scripts/finalize_stale_recordings.py) corrects duration off the
  // file itself anyway, same as it does for any other interrupted recording.
  const body = new FormData();
  body.append("duration_ms", String(total * APPROX_CHUNK_MS));
  body.append("stop_reason", "recovered");
  await fetch(`${API}/api/recordings/${caseId}/${recordingId}/stop`,
              { method: "POST", body, credentials: "include" });
  await forgetRecording(recordingId);
}
