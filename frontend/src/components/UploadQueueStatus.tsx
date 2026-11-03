"use client";

/**
 * "How many recordings are still uploading, and roughly how long is left" --
 * across every recording in this tab, not just whichever one is on screen.
 *
 * Sits where it is visible regardless of which procedure/component is
 * currently mounted (see uploadRegistry.ts for why that matters): a
 * recording keeps draining in the background after the procedure that made
 * it has ended, and auto-record's in-body/out-of-body split means a single
 * busy procedure can leave several of these queued one after another.
 *
 * One line by design -- this answers "is something still happening and
 * roughly how long", not "show me every byte". Someone who wants the detail
 * for the CURRENT recording already has it in RecordingControls.
 */

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { listUploads, estimateSecondsRemaining, subscribe } from "@/lib/uploadRegistry";
import { formatBytes } from "./RecordingControls";

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

export default function UploadQueueStatus({ className = "" }: { className?: string }) {
  const { t } = useLanguage();
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((n) => n + 1)), []);

  const uploads = listUploads();
  if (uploads.length === 0) return null;

  const uploadedBytes = uploads.reduce((a, u) => a + u.uploadedBytes, 0);
  const totalBytes = uploads.reduce((a, u) => a + u.totalBytesEstimate, 0);
  const etaSeconds = estimateSecondsRemaining();

  return (
    <div className={`rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-1.5 text-xs text-sky-200 flex items-center gap-2 ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse shrink-0" />
      <span>
        {uploads.length === 1
          ? t("1 recording still uploading")
          : t("{n} recordings still uploading", { n: uploads.length })}
        {totalBytes > 0 && (
          <> — {t("{done} of {total} sent", { done: formatBytes(uploadedBytes), total: formatBytes(totalBytes) })}</>
        )}
        {etaSeconds != null && etaSeconds > 0 && (
          <> · {t("~{eta} left", { eta: formatEta(etaSeconds) })}</>
        )}
      </span>
    </div>
  );
}
