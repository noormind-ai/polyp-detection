"use client";

import { useLanguage } from "@/lib/i18n";
import { isSpike } from "@/lib/rolling";

/** One metric, in three parts, because the number you read and the number you
 *  judge are not the same number.
 *
 *  `shown` is the short-window average the page has always displayed -- stable
 *  enough to read at 15 updates a second, and the same value that is posted to
 *  room-stats for spectator mode.
 *  `cur` is this frame's raw sample.
 *  `baseline`/`n` are a longer window, so "above its own mean" means "above
 *  how this session has been behaving", not "above the last half second" --
 *  which a spike pollutes within three frames. */
export interface Metric { shown: number; cur: number; baseline: number; n: number }

export interface LatencyStats {
  sent: number;
  received: number;
  /** Total round trip, client stamp to client stamp. */
  rtt: Metric;
  /** timing.modal_ms -- in-process inference time on the server. */
  server: Metric;
  /** rtt minus server: the wire plus the browser. */
  net: Metric;
  /** Replies per second, measured from inter-arrival gaps, not 1000/rtt. */
  fps: Metric;
  /** The one-off upload-speed probe from session start (see page.tsx
   *  openMode), in Mbps -- not a Metric like the others, since it is a
   *  single measurement rather than a running stream of frames. Null until
   *  the probe resolves, or if it never ran. */
  uplinkMbps?: number | null;
}

/** The hard ceiling above which a round trip is a clinical problem rather than
 *  a statistical curiosity. Pre-dates the spike test and is kept alongside it:
 *  a steadily terrible 900 ms never "spikes" above its own mean, and is
 *  exactly the case that most needs to be red. */
const RTT_RED_MS = 800;

/** Measured uplinks below this made 471 of 1,094 recording-chunk uploads
 *  on real clinic links contend with the frame stream (see
 *  LiveCameraPlayer.tsx's gate) -- below it, a slow start is the uplink,
 *  not a transient. */
const UPLINK_WARN_MBPS = 1.0;

function reds(s: LatencyStats) {
  return {
    rtt: s.rtt.shown > RTT_RED_MS || isSpike(s.rtt.cur, s.rtt.baseline, s.rtt.n),
    server: isSpike(s.server.cur, s.server.baseline, s.server.n),
    net: isSpike(s.net.cur, s.net.baseline, s.net.n),
    // Low fps is the failure here, so the test is inverted and its floor is in
    // frames rather than milliseconds.
    fps: isSpike(s.fps.cur, s.fps.baseline, s.fps.n, { invert: true, minDelta: 3 }),
  };
}

/** The latency readout, in two shapes from one implementation.
 *
 *  `compact` is the corner overlay for the fullscreen and doctor views: small
 *  enough not to compete with the picture, pinned dir="ltr" and tabular-nums
 *  so changing digits cannot jitter the layout.
 *
 *  Without it, this is the page's existing debug grid -- same strings in the
 *  same order with the same colours, so the normal view is unchanged and
 *  there is one implementation of these numbers instead of two that drift. */
export default function LatencyHud({
  stats, compact = false, error, className = "",
}: {
  stats: LatencyStats;
  compact?: boolean;
  error?: string | null;
  className?: string;
}) {
  const { t } = useLanguage();
  const red = reds(stats);
  const ms = (m: Metric) => (m.shown > 0 ? t("{ms} ms", { ms: Math.round(m.shown) }) : "—");

  if (compact) {
    // One line, not a grid: over the picture a 2x4 block is a notch out of
    // the corner, a single strip is a caption. tabular-nums keeps the digits
    // from shuffling the line left and right as they change, and each cell
    // has a fixed min-width for the same reason -- a readout that twitches
    // 15 times a second draws the eye it is supposed to stay out of.
    const cell = "inline-flex items-baseline gap-1";
    const num = "tabular-nums min-w-[3.5rem] text-end";
    return (
      <div
        dir="ltr"
        className={`font-mono text-[11px] leading-4 bg-black/70 backdrop-blur-sm rounded-md border border-gray-700 px-2 py-1 flex items-baseline gap-3 whitespace-nowrap ${className}`}
      >
        <span className={cell}>
          <span className="text-gray-500">{t("rtt")}</span>
          <span className={`${num} ${red.rtt ? "text-red-400" : "text-white"}`}>{ms(stats.rtt)}</span>
        </span>
        <span className={cell}>
          <span className="text-gray-500">{t("srv")}</span>
          <span className={`${num} ${red.server ? "text-red-400" : "text-white"}`}>{ms(stats.server)}</span>
        </span>
        <span className={cell}>
          <span className="text-gray-500">{t("net")}</span>
          <span className={`${num} ${red.net ? "text-red-400" : "text-white"}`}>{ms(stats.net)}</span>
        </span>
        <span className={cell}>
          <span className="text-gray-500">{t("fps")}</span>
          <span className={`tabular-nums min-w-[2.5rem] text-end ${red.fps ? "text-red-400" : "text-white"}`}>
            {stats.fps.shown > 0 ? stats.fps.shown.toFixed(1) : "—"}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div
      className={`bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 font-mono text-xs grid grid-cols-2 gap-x-6 gap-y-0.5 ${className}`}
    >
      <span className="text-gray-500">{t("Frames sent")}</span>
      <span className="text-white">{stats.sent}</span>
      <span className="text-gray-500">{t("Responses back")}</span>
      <span className="text-white">{stats.received}</span>
      {/* Round trip split into the half we control and the half we do not. */}
      <span className="text-gray-500">{t("Round trip (avg)")}</span>
      <span className={red.rtt ? "text-red-400" : "text-green-400"}>{ms(stats.rtt)}</span>
      <span className="text-gray-500">{t("— of which server")}</span>
      <span className={red.server ? "text-red-400" : "text-white"}>{ms(stats.server)}</span>
      <span className="text-gray-500">{t("— of which network")}</span>
      <span className={red.net ? "text-red-400" : "text-white"}>
        {stats.rtt.shown > 0 ? ms(stats.net) : "—"}
      </span>
      <span className="text-gray-500">{t("Analysed")}</span>
      <span className={red.fps ? "text-red-400" : "text-white"}>
        {stats.fps.shown > 0 ? t("{fps} fps", { fps: stats.fps.shown.toFixed(1) }) : "—"}
      </span>
      {stats.uplinkMbps != null && <>
        <span className="text-gray-500">{t("Uplink (measured)")}</span>
        <span className={stats.uplinkMbps < UPLINK_WARN_MBPS ? "text-red-400" : "text-white"}>
          {t("{mbps} Mbps", { mbps: stats.uplinkMbps.toFixed(2) })}
        </span>
      </>}
      {stats.uplinkMbps != null && stats.uplinkMbps < UPLINK_WARN_MBPS && (
        <span className="col-span-2 text-[11px] text-amber-400">
          {t("Slow uplink measured — a slow start, or an uploading recording lagging behind, is likely why.")}
        </span>
      )}
      {error && <>
        <span className="text-gray-500">{t("Error")}</span>
        <span className="text-red-400 truncate">{error}</span>
      </>}
    </div>
  );
}
