"use client";

/**
 * Tracks every recording's upload drain across the whole tab, not just
 * whichever one useSessionRecorder's CURRENT hook instance owns.
 *
 * Once a recording stops, finalize() (useSessionRecorder.ts) keeps draining
 * its chunks in the background -- that can take minutes on a slow uplink,
 * and auto-record's in-body/out-of-body split means a single procedure can
 * leave several of these running one after another. The next procedure
 * mounts a FRESH useSessionRecorder instance (new component, new refs), so
 * the previous one's local React state -- uploadedBytes, uploadedChunks,
 * totalChunks -- is still ticking over inside a closure nothing can read
 * from any more. That is the entire reason "several videos uploading, no
 * idea how many are left" was invisible: nothing outside that orphaned
 * closure ever saw its progress. This is a plain module-level singleton
 * (same pattern as uploadCoordinator.ts, for the same reason) so it
 * survives every remount in this tab.
 *
 * Registered only from finalize() onward -- i.e. once a recording has
 * actually stopped and become a background job. The recording currently
 * being captured already has its own visible progress UI (RecordingControls,
 * wired straight to its own hook instance); this file exists for the ones
 * that no longer have a component watching them.
 */

export interface UploadEntry {
  recordingId: string;
  caseId: string;
  /** Best estimate of this recording's total size -- exact once it is
   *  known (all chunks read back from local storage), never revised down. */
  totalBytesEstimate: number;
  uploadedBytes: number;
  totalChunks: number;
  uploadedChunks: number;
  startedAt: number;
}

const entries = new Map<string, UploadEntry>();
const listeners = new Set<() => void>();

function notify() { listeners.forEach((l) => l()); }

export function registerUpload(recordingId: string, caseId: string, totalBytesEstimate: number) {
  entries.set(recordingId, {
    recordingId, caseId, totalBytesEstimate,
    uploadedBytes: 0, totalChunks: 0, uploadedChunks: 0, startedAt: Date.now(),
  });
  notify();
}

export function updateUpload(recordingId: string, patch: Partial<UploadEntry>) {
  const e = entries.get(recordingId);
  if (!e) return;
  Object.assign(e, patch);
  sampleThroughput();
  notify();
}

export function finishUpload(recordingId: string) {
  if (!entries.delete(recordingId)) return;
  notify();
}

export function listUploads(): UploadEntry[] {
  return Array.from(entries.values());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Observed bytes/sec across every tracked upload combined, measured from
 *  real traffic -- not the one-off link-speed probe from session start,
 *  which this deliberately avoids depending on: if that probe turns out to
 *  not match reality (see the open "upload feels slower than it should"
 *  question), an ETA built on it would just repeat the same wrong number.
 *  An exponential moving average so one slow or fast chunk cannot swing the
 *  estimate; naturally drops toward zero on its own while the live-inference
 *  gate (uploadCoordinator.ts) is holding uploads back, which is honest --
 *  that IS the upload rate right now. */
let lastTotalBytes = 0;
let lastSampleAt = 0;
let bytesPerSecEma = 0;

function sampleThroughput() {
  const totalNow = Array.from(entries.values()).reduce((a, e) => a + e.uploadedBytes, 0);
  const now = Date.now();
  if (lastSampleAt > 0) {
    const dtSec = (now - lastSampleAt) / 1000;
    const deltaBytes = totalNow - lastTotalBytes;
    // A big negative jump means a recording finished and left the set
    // (its bytes disappeared with it, not actually "undone upload") --
    // skip that sample rather than let it corrupt the rate.
    if (dtSec > 0.2 && deltaBytes >= 0) {
      const rate = deltaBytes / dtSec;
      bytesPerSecEma = bytesPerSecEma === 0 ? rate : bytesPerSecEma * 0.8 + rate * 0.2;
    }
  }
  lastTotalBytes = totalNow;
  lastSampleAt = now;
}

/** Null when there is not yet enough signal to say anything honest --
 *  deliberately not "0s" or a guess, since an unattended operator reading a
 *  made-up ETA is worse than reading nothing. */
export function estimateSecondsRemaining(): number | null {
  if (entries.size === 0) return 0;
  if (bytesPerSecEma <= 1) return null;
  const remaining = Array.from(entries.values())
    .reduce((a, e) => a + Math.max(0, e.totalBytesEstimate - e.uploadedBytes), 0);
  return Math.max(0, remaining / bytesPerSecEma);
}
