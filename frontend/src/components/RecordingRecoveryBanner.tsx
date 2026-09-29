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
 * hasn't been cleared yet), and offers the two safe actions: save it to disk,
 * or discard it. It deliberately does not offer to resume the upload
 * automatically -- that would need to replicate useSessionRecorder's own
 * retry/abort bookkeeping outside of a live hook instance, for a case (a
 * browser that crashed and was reopened) rare enough not to be worth it yet.
 */

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { listOrphanedRecordings, readOrphanBlobs, forgetRecording, type OrphanedRecording } from "@/lib/chunkStore";

const API = process.env.NEXT_PUBLIC_API_URL || "";

interface Recoverable extends OrphanedRecording {
  serverStatus: string | null; // null = server has never heard of this id
}

export default function RecordingRecoveryBanner() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [items, setItems] = useState<Recoverable[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

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
        <div key={item.recordingId} className="flex items-center justify-between gap-2">
          <span className="font-mono text-amber-300/80">
            {item.caseId} / {item.recordingId} ({(item.bytes / (1024 * 1024)).toFixed(1)} MB)
          </span>
          <div className="flex gap-1.5">
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
      ))}
    </div>
  );
}
