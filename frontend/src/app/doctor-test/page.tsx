"use client";

/**
 * /doctor-test — harness for the presenter mode, with no endoscope attached.
 *
 * Everything the doctor view does that is hard (portalling React into a second
 * browser window, cloning the stylesheet into it, mirroring a canvas across
 * documents, tearing all of that down when someone closes the window) can go
 * wrong without a camera, a GPU session or a patient. This page exercises all
 * of it against a fake animated canvas, so a regression shows up here rather
 * than in a clinic.
 *
 * The frame counter drawn into the canvas is the point of the canvas: it is
 * how you tell "the mirror is live" from "the mirror froze on a plausible
 * still", and how you confirm the picture keeps moving while an enlarged
 * capture is open on top of it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DoctorScreen from "@/components/DoctorScreen";
import CaptureStrip, { StripChooser, STRIP_SIZE_DEFAULT,
         type Shot, type StripPos } from "@/components/CaptureStrip";
import LatencyHud, { type LatencyStats } from "@/components/LatencyHud";
import { Rolling } from "@/lib/rolling";
import {
  useDoctorWindow, doctorRoot, canPlaceWindows, hasSecondDisplay,
  listDisplays, suggestDisplay, type DoctorDisplay,
} from "@/lib/useDoctorWindow";
import { useAuth } from "@/lib/auth";

const ASPECT = "4/3";
const W = 640, H = 480;

export default function DoctorTestPage() {
  const { user, loading } = useAuth();
  useEffect(() => {
    if (!loading && !user) window.location.replace("/login?next=/doctor-test");
  }, [loading, user]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const genRef = useRef(0);
  const frameRef = useRef(0);
  const [shots, setShots] = useState<Shot[]>([]);
  const [stripPos, setStripPos] = useState<StripPos>("bottom");
  const [stripSize, setStripSize] = useState(STRIP_SIZE_DEFAULT);
  const [openShotId, setOpenShotId] = useState<string | null>(null);
  const [hudOn, setHudOn] = useState(true);
  const [displays, setDisplays] = useState<DoctorDisplay[] | null>(null);
  const [chosen, setChosen] = useState(0);
  const doctor = useDoctorWindow();

  const rtt = useRef(new Rolling(60));
  const srv = useRef(new Rolling(60));
  const net = useRef(new Rolling(60));
  const fps = useRef(new Rolling(60));
  const [cur, setCur] = useState({ rtt: 0, srv: 0, net: 0, fps: 0 });
  const spikeRef = useRef(0);

  // The fake source. A moving box and a frame counter at ~15 Hz, the same
  // rate the real annotated canvas repaints at, so the mirror is exercised
  // the way it will be used rather than at 60.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    const id = setInterval(() => {
      const f = ++frameRef.current;
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, W, H);
      const x = (f * 7) % (W - 120);
      ctx.strokeStyle = "#39ff14";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, H / 2 - 60, 120, 120);
      ctx.fillStyle = "#39ff14";
      ctx.font = "bold 48px monospace";
      ctx.fillText(String(f), 20, 60);
      genRef.current++;

      // Latency samples, with an occasional injected spike.
      const spike = spikeRef.current > 0;
      if (spike) spikeRef.current--;
      const s = spike ? 300 : 40 + Math.round(Math.sin(f / 7) * 5);
      const n = spike ? 220 : 25 + Math.round(Math.cos(f / 5) * 4);
      const r = s + n;
      const fv = spike ? 4 : 15;
      rtt.current.push(r); srv.current.push(s); net.current.push(n); fps.current.push(fv);
      setCur({ rtt: r, srv: s, net: n, fps: fv });
    }, 66);
    return () => clearInterval(id);
  }, []);

  const hudStats: LatencyStats = {
    sent: frameRef.current,
    received: frameRef.current,
    rtt: { shown: Math.round(rtt.current.mean), cur: cur.rtt, baseline: rtt.current.mean, n: rtt.current.n },
    server: { shown: Math.round(srv.current.mean), cur: cur.srv, baseline: srv.current.mean, n: srv.current.n },
    net: { shown: Math.round(net.current.mean), cur: cur.net, baseline: net.current.mean, n: net.current.n },
    fps: { shown: Math.round(fps.current.mean * 10) / 10, cur: cur.fps, baseline: fps.current.mean, n: fps.current.n },
  };

  const mirrorSource = useCallback(() => canvasRef.current, []);
  const generation = useCallback(() => genRef.current, []);

  // A synthetic capture: the current fake frame, as a real object URL, so the
  // strip, the eviction and the revoke path are the production ones.
  function addShot(kind: Shot["kind"]) {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((blob) => {
      if (!blob) return;
      const id = `t${Date.now()}${Math.round(performance.now())}`;
      setShots((prev) => [
        {
          id, url: URL.createObjectURL(blob), at: Date.now(), kind,
          boxes: [{
            bbox: [(frameRef.current * 7) % (W - 120), H / 2 - 60,
                   ((frameRef.current * 7) % (W - 120)) + 120, H / 2 + 60] as [number, number, number, number],
            conf: 0.77,
          }],
          w: W, h: H, uploaded: kind !== "first",
        },
        ...prev,
      ].slice(0, 12));
    }, "image/jpeg", 0.82);
  }

  async function pickDisplays() {
    const list = await listDisplays();
    if (list) { setDisplays(list); setChosen(suggestDisplay(list)?.index ?? 0); }
  }

  if (!user) return <main className="min-h-screen bg-gray-950 text-gray-600 p-10 text-center">Checking sign-in…</main>;

  const btn = "text-xs px-2.5 py-1 rounded-md border border-gray-700 text-gray-300 hover:border-gray-500";

  return (
    <main dir="ltr" className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-[1400px] mx-auto p-4 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold">Doctor-screen harness</h1>
            <p className="text-gray-500 text-sm mt-1">
              A fake 15 Hz canvas standing in for the annotated picture. The number drawn on it is
              the frame counter — if it keeps climbing in the doctor window, the mirror is live.
            </p>
          </div>
          <a href="/" className={btn}>← Back</a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => addShot("best")} className={btn}>+ AI capture</button>
          <button onClick={() => addShot("dr")} className={btn}>+ Dr capture</button>
          <button onClick={() => addShot("first")} className={btn}>+ capture (not uploaded)</button>
          <button onClick={() => { spikeRef.current = 8; }} className={btn}>inject latency spike</button>
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={hudOn} onChange={(e) => setHudOn(e.target.checked)} className="accent-blue-500" />
            latency numbers
          </label>
          {!doctor.ready ? (
            <>
              <button onClick={() => doctor.open()} className={btn}>open doctor window (here)</button>
              {canPlaceWindows() && (
                <button onClick={() => void pickDisplays()} className={btn}>
                  list displays {hasSecondDisplay() ? "" : "(only one attached)"}
                </button>
              )}
            </>
          ) : (
            <button onClick={() => doctor.close()} className={btn}>close doctor window</button>
          )}
          {doctor.error === "blocked" && <span className="text-xs text-red-400">popup blocked</span>}
        </div>

        {!doctor.ready && displays && (
          <div className="space-y-1">
            {displays.map((d) => (
              <label key={d.index} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="radio" name="disp" checked={chosen === d.index}
                       onChange={() => setChosen(d.index)} className="accent-blue-500" />
                <span className="font-mono">
                  #{d.index + 1} {d.label} {d.width}×{d.height}
                  {d.isCurrent ? " · this one" : ""}{d.isInternal ? " · built-in" : ""}
                  {d.isPrimary ? " · primary" : ""}
                </span>
              </label>
            ))}
            <button
              className={btn}
              onClick={() => {
                const d = displays.find((x) => x.index === chosen);
                if (d) doctor.open({ left: d.left, top: d.top, width: d.width, height: d.height });
              }}
            >
              open there
            </button>
          </div>
        )}

        {/* The in-page preview: the same source canvas with the same overlays,
            so the strip and HUD can be judged without a second monitor. */}
        <div className="relative bg-black rounded-xl overflow-hidden border border-gray-800 max-w-3xl"
             style={{ aspectRatio: ASPECT }}>
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain" />
          <CaptureStrip shots={shots} position={stripPos} openId={openShotId}
                        onOpen={setOpenShotId} onClose={() => setOpenShotId(null)} size={stripSize} />
          <StripChooser position={stripPos} onChange={setStripPos}
                        size={stripSize} onSize={setStripSize} />
          {hudOn && <LatencyHud stats={hudStats} compact className="absolute top-3 start-3 z-40" />}
        </div>

        <LatencyHud stats={hudStats} />
      </div>

      {doctor.ready && doctor.win && doctorRoot(doctor.win) &&
        createPortal(
          <DoctorScreen
            win={doctor.win}
            mirrorSource={mirrorSource}
            generation={generation}
            aspect={ASPECT}
            shots={shots}
            stripPos={stripPos}
            onStripPos={setStripPos}
            stripSize={stripSize}
            onStripSize={setStripSize}
            openShotId={openShotId}
            onOpenShot={setOpenShotId}
            hudStats={hudStats}
            hudOn={hudOn}
            stopped={false}
          />,
          doctorRoot(doctor.win)!,
        )}
    </main>
  );
}
