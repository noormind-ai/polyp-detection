"use client";

/**
 * "You have an unfinished recording from before" banner.
 *
 * chunkStore.ts's OPFS/IndexedDB backends survive a crashed tab, but the
 * durability is inert unless something surfaces it afterward -- otherwise the
 * bytes just sit there forever. On mount, this scans local storage for
 * recordings nobody finished uploading, cross-checks each against the
 * server (a recording the server already has marked complete/truncated needs
 * no recovery -- its local copy is just leftover from a normal session that
 * hasn't been cleared yet), and offers three actions: save it to disk,
 * finish uploading it, or discard it.
 *
 * Still never resumed automatically on mount -- only an explicit click
 * drives drainOrphanToServer() (recordingUpload.ts). That keeps a browser
 * that was reopened from silently spending someone's bandwidth the moment
 * the page loads; the operator decides when.
 */

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { listOrphanedRecordings, readOrphanBlobs, forgetRecording, type OrphanedRecording } from "@/lib/chunkStore";
import { drainOrphanToServer, type DrainProgress } from "@/lib/recordingUpload";

const API = process.env.NEXT_PUBLIC_API_URL || "";

interface Recoverable extends OrphanedRecording {
  serverStatus: string | null; // null = server has never heard of this id
}

export default function RecordingRecoveryBanner() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [items, setItems] = useState<Recoverable[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<DrainProgress | null>(null);
  const [uploadError, setUploadError] = useState<{ recordingId: string; message: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const orphans = await listOrphanedRecordings();
      if (orphans.length === 0 || cancelled) return;
      const byCase = new Map<string, OrphanedRecording[]>();
      for (const o of orphans) {
        if (!byCase.has(o.caseId)) byCase.set(o.caseId, []);
        byCase.get(o.caseId)!.push(o);
      }
      const recoverable: Recoverable[] = [];
      for (const [caseId, group] of Array.from(byCase.entries())) {
        let serverList: { id: string; status: string }[] = [];
        try {
          const res = await fetch(`${API}/api/recordings?case_id=${encodeURIComponent(caseId)}`,
                                  { credentials: "include" });
          if (res.ok) serverList = await res.json();
        } catch { /* treat as unknown below */ }
        for (const o of group) {
          const match = serverList.find((r) => r.id === o.recordingId);
          const status = match?.status ?? null;
          // Already fully landed server-side -- nothing to recover, just a
          // local copy the next successful session will clear on its own.
          if (status === "complete" || status === "truncated") continue;
          recoverable.push({ ...o, serverStatus: status });
        }
      }
      if (!cancelled) setItems(recoverable);
    })();
    return () => { cancelled = true; };
  }, [user]);

  if (items.length === 0) return null;

  async function download(item: Recoverable) {
    setBusy(item.recordingId);
    try {
      const found = await readOrphanBlobs(item.recordingId);
      if (!found || found.blobs.length === 0) {
        setItems((cur) => cur.filter((i) => i.recordingId !== item.recordingId));
        return;
      }
      const blob = new Blob(found.blobs, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `noormind-${item.caseId}-${item.recordingId}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } finally {
      setBusy(null);
    }
  }

  async function upload(item: Recoverable) {
    setBusy(item.recordingId);
    setUploadError(null);
    setProgress(null);
    try {
      await drainOrphanToServer(item.caseId, item.recordingId, setProgress);
      setItems((cur) => cur.filter((i) => i.recordingId !== item.recordingId));
    } catch (err) {
      // Left in the list on failure (same as not having clicked it) -- the
      // chunks are still sitting in local storage, nothing lost, retryable.
      setUploadError({ recordingId: item.recordingId, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function discard(item: Recoverable) {
    setBusy(item.recordingId);
    try {
      await forgetRecording(item.recordingId);
      setItems((cur) => cur.filter((i) => i.recordingId !== item.recordingId));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-xs text-amber-200 space-y-2">
      <p className="font-medium">
        {t("⚠ Found {count} unfinished recording(s) from a previous session that never finished uploading.", { count: items.length })}
      </p>
      {items.map((item) => (
        <div key={item.recordingId} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-amber-300/80">
              {item.caseId} / {item.recordingId} ({(item.bytes / (1024 * 1024)).toFixed(1)} MB)
            </span>
            <div className="flex gap-1.5">
              <button
                type="button" disabled={busy === item.recordingId}
                onClick={() => void upload(item)}
                className="rounded-lg border border-emerald-600/60 px-2 py-1 hover:bg-emerald-800/30 disabled:opacity-40"
              >
                {busy === item.recordingId && progress
                  ? t("Uploading {done}/{total}…", { done: progress.uploadedChunks, total: progress.totalChunks })
                  : t("⬆ Upload to server")}
              </button>
              <button
                type="button" disabled={busy === item.recordingId}
                onClick={() => void download(item)}
                className="rounded-lg border border-amber-600/60 px-2 py-1 hover:bg-amber-800/30 disabled:opacity-40"
              >
                {t("⬇ Save to computer")}
              </button>
              <button
                type="button" disabled={busy === item.recordingId}
                onClick={() => void discard(item)}
                className="rounded-lg border border-gray-700 px-2 py-1 text-gray-400 hover:text-white disabled:opacity-40"
              >
                {t("Discard")}
              </button>
            </div>
          </div>
          {uploadError?.recordingId === item.recordingId && busy !== item.recordingId && (
            <p className="text-red-400">{t("Upload failed: {error}", { error: uploadError.message })}</p>
          )}
        </div>
      ))}
    </div>
  );
}
