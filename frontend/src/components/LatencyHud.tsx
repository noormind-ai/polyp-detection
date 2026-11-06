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
  /** Time to shrink the raw source frame down to the model's input width
   *  (LiveCameraPlayer's resizeMsRef) -- a plain number like uplinkMbps, not
   *  a baseline-tracked Metric, since this exists to answer one question
   *  ("does a bigger source frame cost more to resize") rather than to be
   *  watched for spikes. Was previously invisible, folded into `net` below. */
  resizeMs?: number | null;
  /** Time to draw the near-full-resolution filing copy of the same native
   *  frame (LiveCameraPlayer's grabMsRef) -- runs every loop regardless of
   *  whether anything gets filed, reads from the same big source resizeMs
   *  does, and was never measured until a bigger HDMI source made it worth
   *  checking: a slow client step here shows up as the server's recv_ms
   *  going up, with nothing in bytesSent or resizeMs explaining why. */
  grabMs?: number | null;
  /** Time to JPEG-encode the resized frame (cap.toBlob). Can be hardware-
   *  accelerated on one machine and a slow software fallback on another,
   *  with identical resizeMs/grabMs on both -- the third unmeasured client
   *  step, after resize and the filing-copy grab. */
  encodeMs?: number | null;
  /** encodeMs split into its four real pieces -- see jpegEncoder.ts's
   *  EncodeTiming for the full reasoning. bitmapMs and returnWaitMs are
   *  main-thread cost (createImageBitmap, and the wait after the worker
   *  already replied); handoffMs is mostly message-passing overhead;
   *  workerEncodeMs is the actual compression, isolated on its own thread
   *  -- the one number an encode-only benchmark run with nothing else
   *  competing for the CPU would measure. */
  bitmapMs?: number | null;
  handoffMs?: number | null;
  workerEncodeMs?: number | null;
  returnWaitMs?: number | null;
  /** Size of the JPEG this tab actually sent for the last frame, in bytes.
   *  Pixel size (320px) is fixed either way -- this is here to check whether
   *  a more detailed source compresses to more bytes at that same width,
   *  which the resize-time number above cannot show. */
  bytesSent?: number | null;
  /** Server's own direct measurement of how long it waited to receive a
   *  frame's bytes -- unlike `net` (rtt minus modal_ms, a leftover by
   *  subtraction), this is a real measurement of one specific thing. */
  recvMs?: number | null;
  /** How long after ws.send() the browser's own outgoing buffer actually
   *  drained (WebSocket.bufferedAmount polled back to its pre-send level).
   *  Separates two things recvMs alone cannot: a slow arrival the SERVER
   *  reports could be a genuinely slow network, or it could be that this
   *  tab was too CPU-busy to have finished pushing the bytes out yet. A
   *  high sendDrainMs here, especially correlated with recvMs, points at
   *  the second case -- quality dropping for a reason that lowering quality
   *  cannot fix. */
  sendDrainMs?: number | null;
  /** Count and most recent duration of browser "longtask" events (main
   *  thread blocked 50ms+) since this session started. A standard signal,
   *  not app-specific -- fires for ANY cause, including ones outside this
   *  code (a browser extension's own listener, for example). Zero means
   *  the main thread genuinely has not been the problem, which is itself
   *  useful: it rules out a whole category instead of leaving it unknown. */
  longTaskCount?: number | null;
  longTaskMs?: number | null;
  /** Current AIMD-adjusted JPEG quality (0-1). Shown so a lower number has
   *  a visible reason instead of looking like an unexplained quality drop. */
  quality?: number | null;
  /** The operator-set floor this session is trying to protect. Shown next
   *  to `quality` so "why is quality low" and "why is fps below what I
   *  asked for" read as the same tradeoff, not two separate mysteries. */
  targetFps?: number | null;
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
      {/* Part of "network" above, shown again on its own: the resize-to-320
          step specifically, so a bigger source frame costing more to shrink
          shows up as its own number instead of staying hidden inside net. */}
      {stats.resizeMs != null && (
        <>
          <span className="text-gray-500 pl-3">{t("   · of which resize")}</span>
          <span className="text-gray-400">
            {stats.resizeMs > 0 ? t("{ms} ms", { ms: Math.round(stats.resizeMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.grabMs != null && (
        <>
          <span className="text-gray-500 pl-3">{t("   · of which filing-copy grab")}</span>
          <span className="text-gray-400">
            {stats.grabMs > 0 ? t("{ms} ms", { ms: Math.round(stats.grabMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.encodeMs != null && (
        <>
          <span className="text-gray-500 pl-3">{t("   · of which JPEG encode")}</span>
          <span className="text-gray-400">
            {stats.encodeMs > 0 ? t("{ms} ms", { ms: Math.round(stats.encodeMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {/* The breakdown of the row above -- which of the four pieces is
          actually costly, instead of one lumped number. */}
      {stats.bitmapMs != null && (
        <>
          <span className="text-gray-500 pl-6">{t("      · bitmap copy (main thread)")}</span>
          <span className="text-gray-400">
            {stats.bitmapMs > 0 ? t("{ms} ms", { ms: Math.round(stats.bitmapMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.handoffMs != null && (
        <>
          <span className="text-gray-500 pl-6">{t("      · handoff to worker")}</span>
          <span className="text-gray-400">
            {stats.handoffMs > 0 ? t("{ms} ms", { ms: Math.round(stats.handoffMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.workerEncodeMs != null && (
        <>
          <span className="text-gray-500 pl-6">{t("      · worker compression")}</span>
          <span className="text-gray-400">
            {stats.workerEncodeMs > 0 ? t("{ms} ms", { ms: Math.round(stats.workerEncodeMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.returnWaitMs != null && (
        <>
          <span className="text-gray-500 pl-6">{t("      · wait for main thread")}</span>
          <span className="text-gray-400">
            {stats.returnWaitMs > 0 ? t("{ms} ms", { ms: Math.round(stats.returnWaitMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.recvMs != null && (
        <>
          <span className="text-gray-500 pl-3">{t("   · of which server recv")}</span>
          <span className="text-gray-400">
            {stats.recvMs > 0 ? t("{ms} ms", { ms: Math.round(stats.recvMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.sendDrainMs != null && (
        <>
          <span className="text-gray-500 pl-3">{t("   · client send-buffer drain")}</span>
          <span className="text-gray-400">
            {stats.sendDrainMs > 0 ? t("{ms} ms", { ms: Math.round(stats.sendDrainMs * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      {stats.bytesSent != null && (
        <>
          <span className="text-gray-500">{t("Sent frame size")}</span>
          <span className="text-gray-400">
            {stats.bytesSent > 0 ? t("{kb} KB", { kb: Math.round(stats.bytesSent / 1024 * 10) / 10 }) : "—"}
          </span>
        </>
      )}
      <span className="text-gray-500">{t("Analysed")}</span>
      <span className={red.fps ? "text-red-400" : "text-white"}>
        {stats.fps.shown > 0 ? t("{fps} fps", { fps: stats.fps.shown.toFixed(1) }) : "—"}
      </span>
      {/* The tradeoff this session is actually making, spelled out: quality
          is the dial, targetFps is the thing it's protecting. Shown
          together so a low quality number always has a visible reason. */}
      {stats.quality != null && (
        <>
          <span className="text-gray-500">{t("Send quality")}</span>
          <span className="text-gray-400">
            {t("{pct}% (target {fps} fps)", { pct: Math.round(stats.quality * 100), fps: stats.targetFps ?? "—" })}
          </span>
        </>
      )}
      {stats.quality != null && stats.targetFps != null && stats.fps.shown > 0
        && stats.fps.shown < stats.targetFps - 1 && (
        <span className="col-span-2 text-[11px] text-amber-400">
          {t("Running below the {fps} fps target even at this quality — the uplink can't keep up, not a bug.", { fps: stats.targetFps })}
        </span>
      )}
      {/* "Uplink can't keep up" above is the AIMD's own explanation, and it
          only ever looks at recv_ms -- it has no way to know whether the
          main thread, not the network, is the real reason. This is that
          second, independent check: longtask is a browser-level signal, not
          something this app computed, so if it is non-zero while quality is
          dropping, that is direct evidence against "it's the network". */}
      {stats.longTaskCount != null && (
        <>
          <span className="text-gray-500">{t("Main thread blocked")}</span>
          <span className={stats.longTaskCount > 0 ? "text-amber-400" : "text-gray-400"}>
            {stats.longTaskCount > 0
              ? t("{n}x, longest {ms} ms", { n: stats.longTaskCount, ms: Math.round(stats.longTaskMs ?? 0) })
              : t("never (this session)")}
          </span>
        </>
      )}
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
