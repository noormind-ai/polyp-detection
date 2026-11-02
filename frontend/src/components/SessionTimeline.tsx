"use client";

import { useLanguage } from "@/lib/i18n";

/**
 * The bar under the review picture: the whole procedure so far, with a spot per
 * frame the AI captured. Click a spot to land on it, click anywhere else to
 * play from there.
 *
 * It replaces the two thumbnail strips that used to sit under the review card.
 * The spots do that job and also answer the question the strips never could --
 * WHEN in the procedure, and how far back the doctor has to pull the scope.
 */

export type SpotState = "pending" | "confirmed" | "rejected" | "dr";

export interface Spot {
  /** The capture's filename, which is its identity everywhere else too. */
  id: string;
  /** Milliseconds since the procedure started. */
  atMs: number;
  state: SpotState;
  /** Best AI confidence on that frame, for the tooltip. 0 for doctor-found. */
  conf: number;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const SPOT_COLOUR: Record<SpotState, string> = {
  // Unreviewed is the brightest: it is the one that still wants attention.
  pending: "bg-gray-100",
  confirmed: "bg-emerald-400",
  rejected: "bg-gray-600",
  dr: "bg-sky-400",
};

export default function SessionTimeline({
  totalMs, playableFromMs, spots, selectedId, playheadMs, onSelectSpot, onSeek,
}: {
  totalMs: number;
  /** Oldest moment that can still be PLAYED. Older spots are still clickable --
   *  their still frame is on the server -- but there is no video for them. */
  playableFromMs: number;
  spots: Spot[];
  selectedId: string | null;
  /** Null when a still is showing rather than motion. */
  playheadMs: number | null;
  onSelectSpot: (id: string) => void;
  onSeek: (atMs: number) => void;
}) {
  const { t } = useLanguage();
  const span = Math.max(1, totalMs);
  const pct = (ms: number) => Math.min(100, Math.max(0, (ms / span) * 100));

  return (
    // dir=ltr: a timeline runs left-to-right in every language. Flipping it for
    // Farsi would put the start of the procedure on the right, which is not a
    // translation of anything -- the same reasoning as the transport row and
    // the Detected/Live grid in the live player.
    <div dir="ltr" className="flex items-center gap-2 text-[11px] font-mono text-gray-500 select-none">
      <span className="flex-shrink-0">0:00</span>

      <div
        className="relative flex-1 h-6 rounded-md bg-gray-800/80 cursor-pointer overflow-hidden"
        title={t("Click to play from that moment")}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width <= 0) return;
          onSeek(((e.clientX - r.left) / r.width) * span);
        }}
      >
        {/* What is actually playable. Beyond it the spots still work as stills,
            so showing the boundary is the difference between "nothing there"
            and "no video for that bit". */}
        <div
          className="absolute inset-y-0 bg-gray-700/60"
          style={{ left: `${pct(playableFromMs)}%`, right: 0 }}
        />

        {spots.map((s) => {
          const selected = s.id === selectedId;
          return (
            <button
              key={s.id}
              onClick={(e) => { e.stopPropagation(); onSelectSpot(s.id); }}
              title={t("{at} · {conf}%", { at: clock(s.atMs), conf: Math.round(s.conf * 100) })}
              aria-label={clock(s.atMs)}
              className={`absolute top-0 bottom-0 ${SPOT_COLOUR[s.state]} ${
                selected ? "w-[3px] ring-1 ring-white z-20" : "w-[2px] hover:w-[3px] z-10"
              }`}
              style={{ left: `${pct(s.atMs)}%` }}
            />
          );
        })}

        {playheadMs !== null && (
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-white/90 z-30 pointer-events-none"
            style={{ left: `${pct(playheadMs)}%` }}
          />
        )}
      </div>

      <span className="flex-shrink-0">{clock(totalMs)}</span>
    </div>
  );
}
