"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import type { Box } from "@/lib/drawBoxes";
import type { RingFrame } from "@/lib/frameRing";
import ReplaySurface from "./ReplaySurface";

/** One filed capture, held client-side for the life of the session.
 *
 *  `url` is an object URL over the very blob that was handed to the uploader,
 *  not a round trip to /api/feedback/.../image/... . That matters for more
 *  than speed: the strip has to show a capture the instant it is taken, and
 *  the server copy does not exist until a POST that deliberately queues behind
 *  one in-flight upload has finished. Re-fetching would also put N image GETs
 *  on the same clinic uplink the frame stream is already competing for -- the
 *  contention that produced 81x499 and 15x408 in nginx in one day (see the
 *  comment on uploadingRef in LiveCameraPlayer).
 *
 *  `uploaded` is therefore not decoration. deferredRef holds exactly one
 *  capture behind an in-flight upload, so a second deferral overwrites the
 *  first and that blob never reaches the server. A tile the reviewer will
 *  never find in the queue must not look identical to one they will. */
export interface Shot {
  id: string;
  url: string;
  at: number;
  kind: "first" | "best" | "dr";
  /** Pixel coordinates in the captured image's own space -- considerBest and
   *  captureDrFound both rescale into it, so these can be drawn as plain
   *  percentages of the <img> without knowing its displayed size. */
  boxes: Box[];
  w: number;
  h: number;
  uploaded: boolean;
}

/** What the enlarged view needs to play forward from the capture being looked
 *  at, rather than only show it as a still.
 *
 *  Optional, because nothing about the strip depends on it: a view with no
 *  frames behind it -- the doctor window before a procedure starts, say --
 *  simply does not offer the button. */
export interface StripReplay {
  /** The frames this patient's model pass scored. Read live, so playing to the
   *  live edge follows the procedure. */
  getFrames: () => RingFrame[];
  /** Wall clock at which the procedure started, which turns a Shot.at into a
   *  position on the frame store's own axis. */
  procStartMs: number;
}

/** Run-up a replay opens with, so it shows the approach to the lesion rather
 *  than the lesion already centred. */
const PLAY_LEAD_MS = 3000;

export type StripPos = "bottom" | "top" | "right" | "off";

export const STRIP_POSITIONS: StripPos[] = ["bottom", "top", "right", "off"];

/** Tile size as a PERCENTAGE of the band's long axis, smallest to largest.
 *
 *  Percentages rather than the fixed pixels this used to carry, because the
 *  same strip has to work on a laptop panel and on a wall-mounted clinic
 *  monitor. A 288px tile was a sixth of a 1080p width and a twelfth of a 4K
 *  one: the top of the range kept shrinking as the screen got bigger, which
 *  is backwards. On 1920 these give 100/154/211/288/384/500 px; on 4K they
 *  give twice that.
 *
 *  Six steps where there were five -- the extra one is at the top, which is
 *  what was asked for. clampStripSize bounds against the array length, so a
 *  stored index from the old five-entry table is still valid and simply
 *  lands one step bigger. */
export const STRIP_SIZES = [5, 8, 11, 15, 20, 26];
/** 8% -- about 154px on a 1080p screen, i.e. roughly where the old default sat. */
export const STRIP_SIZE_DEFAULT = 1;

/** Below this a tile is a smudge rather than a thumbnail, whatever the band
 *  width says. */
const TILE_MIN_PX = 72;
/** Used for the single frame before the band has been measured, so the first
 *  paint is roughly right instead of zero-width. */
const BAND_FALLBACK_PX = 960;
/** Tailwind p-2 on the rail, both sides. */
const RAIL_PAD = 16;
/** Tailwind gap-2. */
const RAIL_GAP = 8;
/** How much larger the newest capture is drawn than the rest. The band's
 *  height follows the tallest tile, so this is also how much more of the
 *  picture the strip covers -- 1.5 reads as "that one first" without the
 *  strip becoming the main event. */
const NEWEST_SCALE = 1.5;

export function clampStripSize(n: number): number {
  return Math.min(STRIP_SIZES.length - 1, Math.max(0, Math.round(n)));
}

/** Tiles are 10:7, close enough to both 4:3 and 16:9 to crop tidily.
 *
 *  `bandPx` is the long axis of the rail: its width when the strip is along
 *  the top or bottom, its height when it is down the side. */
export function tileBox(size: number, bandPx: number) {
  const band = bandPx > 0 ? bandPx : BAND_FALLBACK_PX;
  const w = Math.max(TILE_MIN_PX, Math.round((band * STRIP_SIZES[clampStripSize(size)]) / 100));
  return { w, h: Math.round(w * 0.7) };
}

/** How many tiles fit COMPLETELY, counting the newest one at its larger size.
 *
 *  The strip used to scroll, which meant whichever tile landed at the band's
 *  edge was sliced in half -- it read as a rendering fault rather than as
 *  "there is more this way". Showing only whole tiles also makes the size
 *  control do exactly what it says: bigger frames, fewer of them. The ones
 *  that no longer fit are still in the ring, the review column's own strip
 *  and the server queue; they are just not on the doctor's screen. */
function tilesThatFit(bandPx: number, tile: number): number {
  const avail = (bandPx > 0 ? bandPx : BAND_FALLBACK_PX) - RAIL_PAD;
  const first = tile * NEWEST_SCALE;
  if (avail < first) return 1;
  return 1 + Math.max(0, Math.floor((avail - first - RAIL_GAP) / (tile + RAIL_GAP)));
}

/** Measure an element's long axis, and keep measuring as the window changes.
 *
 *  The ResizeObserver is taken from the ELEMENT's own window, not the global
 *  one: in the doctor popup this component is portalled into a foreign
 *  document, where the bare global belongs to the opener. */
function useBandPx(el: HTMLElement | null, vertical: boolean): number {
  const [px, setPx] = useState(0);
  useEffect(() => {
    if (!el) return;
    const measure = () => setPx(vertical ? el.clientHeight : el.clientWidth);
    measure();
    const view = el.ownerDocument?.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
    if (!view?.ResizeObserver) return;   // ancient browser: the one measurement stands
    const ro = new view.ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, vertical]);
  return px;
}

/** Label for a strip position, for the chooser. Exported so the chooser can
 *  live next to the video while the strip itself is somewhere else. */
export function stripPosLabel(p: StripPos): string {
  return p === "bottom" ? "Bottom" : p === "top" ? "Top" : p === "right" ? "Right" : "Off";
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** The strip of recent captures, and the enlarged view of one of them.
 *
 *  Deliberately an OVERLAY and not a layout band. fsBoxStyle (lib/useFullscreen)
 *  sizes the video box as min(100vw, 100vh * ratio) and its own comment
 *  explains why the box ratio must equal the frame ratio -- the Live panel's
 *  crop zoom and the FOV overlay are both positioned as fractions of that box.
 *  Reserving height for a strip would leave the box describing a viewport that
 *  no longer exists. So the strip floats over the picture instead, and "Off"
 *  is how you get the covered band back.
 *
 *  The enlarged view is absolute inset-0 within this same root, layered over
 *  the video rather than replacing it: the canvas underneath keeps painting by
 *  construction, so nothing about the live session pauses while a doctor looks
 *  back at a frame.
 *
 *  `win` is the window the markup actually lives in. In the doctor popup that
 *  is NOT the global `window` -- a React portal renders into a foreign
 *  document while every bare global still refers to the opener -- so the
 *  Escape listener has to be bound to the window the user is typing into. */
export default function CaptureStrip({
  shots, position, openId, onOpen, onClose, size = STRIP_SIZE_DEFAULT, win, replay,
}: {
  shots: Shot[];
  position: StripPos;
  openId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
  /** Index into STRIP_SIZES. */
  size?: number;
  win?: Window | null;
  replay?: StripReplay;
}) {
  const { t } = useLanguage();
  const open = shots.find((s) => s.id === openId) ?? null;
  // Motion, in the enlarged view, instead of the still. Reset whenever a
  // different capture is opened: the picture would otherwise be of one moment
  // and the label of another.
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setPlaying(false); }, [openId]);
  // A state ref, not useRef: the observer effect has to re-run when the node
  // actually appears, and a ref assignment does not re-render.
  const [railEl, setRailEl] = useState<HTMLElement | null>(null);
  const bandPx = useBandPx(railEl, position === "right");

  useEffect(() => {
    if (!open) return;
    const w = win ?? (typeof window === "undefined" ? null : window);
    if (!w) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    w.addEventListener("keydown", onKey);
    return () => w.removeEventListener("keydown", onKey);
  }, [open, onClose, win]);

  if (position === "off" && !open) return null;

  const vertical = position === "right";
  const box = tileBox(size, bandPx);
  // Nothing scrolls any more -- see tilesThatFit. overflow-hidden is what
  // guarantees a tile is never sliced by the band's edge even for the frame
  // between a resize and the re-measure.
  const rail =
    vertical
      ? "absolute top-0 bottom-0 end-0 flex flex-col gap-2 overflow-hidden p-2"
      : position === "top"
      ? "absolute top-0 inset-x-0 flex gap-2 overflow-hidden p-2"
      : "absolute bottom-0 inset-x-0 flex gap-2 overflow-hidden p-2";
  // The vertical rail has to be wide enough for the NEWEST tile, not the
  // ordinary ones, or it clips the very frame it is meant to feature.
  const railStyle = vertical
    ? { width: Math.round(box.w * NEWEST_SCALE) + RAIL_PAD }
    : undefined;
  const visible = shots.slice(0, tilesThatFit(bandPx, vertical ? box.h : box.w));
  const now = Date.now();

  return (
    <>
      {position !== "off" && shots.length > 0 && (
        // dir="ltr" so "newest first" stays physically newest-first whichever
        // way the app is reading -- same reason the panel grids are pinned.
        <div ref={setRailEl} dir="ltr" style={railStyle}
             className={`${rail} z-20 bg-black/55 backdrop-blur-sm`}>
          {visible.map((s, i) => {
            // shots[0] is the newest -- pushShot prepends -- and the rail is
            // pinned dir="ltr" so it stays physically first under RTL too.
            // Drawn larger and in a warmer border because it is the frame a
            // doctor glancing down is almost always looking for.
            const newest = i === 0;
            const tw = newest ? Math.round(box.w * NEWEST_SCALE) : box.w;
            const th = newest ? Math.round(box.h * NEWEST_SCALE) : box.h;
            return (
              <button
                key={s.id}
                onClick={() => onOpen(s.id)}
                title={t("Captured {ago} ago", { ago: ago(s.at, now) })}
                style={{ width: tw, height: th }}
                className={`relative flex-shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${
                  s.id === openId
                    ? "border-blue-500"
                    : newest
                    ? "border-emerald-400 hover:border-blue-500"
                    : "border-gray-700 hover:border-blue-500"
                } ${s.uploaded ? "" : "opacity-50"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt="" className="w-full h-full object-cover" />
                <span
                  className={`absolute bottom-0 inset-x-0 leading-4 text-white ${
                    tw >= 160 ? "text-[11px]" : "text-[9px]"
                  } ${s.kind === "dr" ? "bg-sky-600/90" : "bg-emerald-700/90"}`}
                >
                  {s.kind === "dr" ? t("Dr") : t("AI")} · {ago(s.at, now)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {open && (
        <div
          className="absolute inset-0 z-30 bg-black/85 flex items-center justify-center"
          onClick={onClose}
        >
          <div
            className="relative max-w-[90%] max-h-[90%]"
            onClick={(e) => e.stopPropagation()}
            style={{ aspectRatio: !playing && open.w && open.h ? `${open.w}/${open.h}` : undefined }}
          >
            {playing && replay ? (
              // The frames the model scored, from a few seconds before this
              // capture, forward to the live edge. The live canvas underneath
              // keeps painting by construction, so nothing about the procedure
              // pauses while the room looks back.
              <div className="w-[75vw] max-w-[1100px]">
                <ReplaySurface
                  getFrames={replay.getFrames}
                  startAtMs={Math.max(0, open.at - replay.procStartMs - PLAY_LEAD_MS)}
                  onPos={() => { /* no timeline to drive from in here */ }}
                  onExit={() => setPlaying(false)}
                />
              </div>
            ) : (
            <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={open.url} alt="" className="w-full h-full object-contain" />
            {/* The stored boxes are in this image's own pixel space, so a
                percentage box lands correctly at any displayed size without
                measuring the element. */}
            {open.w > 0 && open.h > 0 && open.boxes.map((b, i) => (
              <div
                key={i}
                className="absolute border-2 pointer-events-none"
                style={{
                  borderColor: "#39ff14",
                  boxShadow: "0 0 10px #39ff14",
                  left: `${(b.bbox[0] / open.w) * 100}%`,
                  top: `${(b.bbox[1] / open.h) * 100}%`,
                  width: `${((b.bbox[2] - b.bbox[0]) / open.w) * 100}%`,
                  height: `${((b.bbox[3] - b.bbox[1]) / open.h) * 100}%`,
                }}
              />
            ))}
            </>
            )}
            {replay && !playing && (
              <button
                onClick={() => setPlaying(true)}
                title={t("Play from a few seconds before this frame, forward to now")}
                className="absolute top-2 start-2 text-sm px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white"
              >
                {t("▶ Play from here")}
              </button>
            )}
            <button
              onClick={onClose}
              className="absolute top-2 end-2 text-sm px-3 py-1.5 rounded-md bg-black/80 border border-gray-500 text-gray-100 hover:bg-black"
            >
              {t("Close")}
            </button>
            <span
              dir="ltr"
              className={`${playing ? "hidden" : ""} absolute bottom-2 start-2 text-[11px] font-mono text-gray-300 bg-black/70 rounded px-2 py-0.5`}
            >
              {open.kind === "dr" ? t("Dr") : t("AI")} · {ago(open.at, now)}
              {open.uploaded ? "" : ` · ${t("not uploaded")}`}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

/** The four-way position chooser.
 *
 *  Small, overlaid and self-dimming on purpose: the requirement is that it
 *  stays reachable without taking a single pixel of layout from the video. */
export function StripChooser({
  position, onChange, size = STRIP_SIZE_DEFAULT, onSize, win,
}: {
  position: StripPos;
  onChange: (p: StripPos) => void;
  size?: number;
  onSize?: (n: number) => void;
  win?: Window | null;
}) {
  const { t } = useLanguage();
  // The readout shows a pixel width, not the raw percentage ("8" means
  // nothing to a reader) -- measured against the viewport the control is
  // bound to, since this component sits beside the rail rather than inside
  // it and has no element sized like the rail to read from directly. The
  // fullscreen video box tracks the viewport closely enough in both
  // dimensions for this to be a good preview; the rail's own ResizeObserver
  // (in CaptureStrip) is what the tiles actually render at.
  const chooserWin = win ?? (typeof window === "undefined" ? null : window);
  const chooserBandPx = position === "right" ? chooserWin?.innerHeight ?? 0 : chooserWin?.innerWidth ?? 0;
  const previewBox = tileBox(size, chooserBandPx);
  // Dims itself rather than disappearing: a control that vanishes is a control
  // nobody finds again mid-procedure. Bound to `win` for the same reason the
  // Escape handler above is -- in the doctor popup the global is the opener's.
  const [dim, setDim] = useState(false);
  useEffect(() => {
    const w = win ?? (typeof window === "undefined" ? null : window);
    if (!w) return;
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setDim(false);
      clearTimeout(timer);
      timer = setTimeout(() => setDim(true), 3000);
    };
    wake();
    w.addEventListener("pointermove", wake);
    return () => { clearTimeout(timer); w.removeEventListener("pointermove", wake); };
  }, [win]);

  return (
    <div
      dir="ltr"
      className={`absolute bottom-3 start-3 z-40 flex items-center gap-1 rounded-md bg-black/70 backdrop-blur-sm border border-gray-700 px-1.5 py-1 transition-opacity ${
        dim ? "opacity-25" : "opacity-100"
      }`}
    >
      <span className="text-[10px] text-gray-400 pe-1">{t("Captured frames")}</span>
      {STRIP_POSITIONS.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${
            p === position ? "bg-blue-600 text-white" : "text-gray-300 hover:bg-gray-700"
          }`}
        >
          {t(stripPosLabel(p))}
        </button>
      ))}

      {/* Size. Hidden when the strip is off, because resizing nothing is not
          a control. A bigger tile means fewer fit in the same band -- the
          band itself never grows, so the picture never shrinks. */}
      {onSize && position !== "off" && (
        <span className="flex items-center gap-0.5 ps-1 ms-1 border-s border-gray-700">
          <button
            onClick={() => onSize(clampStripSize(size - 1))}
            disabled={size <= 0}
            title={t("Smaller frames")}
            className="text-[13px] leading-none w-5 h-5 rounded text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            −
          </button>
          <span className="text-[10px] text-gray-500 tabular-nums w-10 text-center">
            {previewBox.w}
          </span>
          <button
            onClick={() => onSize(clampStripSize(size + 1))}
            disabled={size >= STRIP_SIZES.length - 1}
            title={t("Bigger frames")}
            className="text-[13px] leading-none w-5 h-5 rounded text-gray-300 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            +
          </button>
        </span>
      )}
    </div>
  );
}
