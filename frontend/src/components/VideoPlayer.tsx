"use client";

import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";

interface Detection {
  bbox: [number, number, number, number];
  conf: number;
}

interface GtBox {
  bbox: [number, number, number, number];
}

interface Props {
  src: string;
  detections: Detection[][];
  fps: number;
  width: number;
  height: number;
  groundTruth?: GtBox[][];
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export default function VideoPlayer({ src, detections, fps, width, height, groundTruth }: Props) {
  const { t } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }

  function handleStop() {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
    setPlaying(false);
  }

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d")!;

    function drawBox(x1: number, y1: number, x2: number, y2: number, color: string, label?: string) {
      // Outer glow so boxes pop on any tissue color
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.shadowBlur = 0;

      if (label) {
        ctx.font = "bold 13px monospace";
        const textW = ctx.measureText(label).width;
        ctx.fillStyle = color;
        ctx.fillRect(x1, y1 - 20, textW + 8, 20);
        ctx.fillStyle = "#000";
        ctx.fillText(label, x1 + 4, y1 - 5);
      }
    }

    function drawFrame() {
      if (!video || !canvas) { rafRef.current = requestAnimationFrame(drawFrame); return; }

      const frameIdx = Math.min(Math.floor(video.currentTime * fps), detections.length - 1);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Ground truth boxes — cyan
      const gtFrame = groundTruth?.[frameIdx] ?? [];
      for (const gt of gtFrame) {
        const [x1, y1, x2, y2] = gt.bbox;
        drawBox(x1, y1, x2, y2, "#22d3ee");
      }

      // Predicted boxes — lime green (all confidence levels, most visible on pink tissue)
      const predFrame = detections[frameIdx] ?? [];
      for (const det of predFrame) {
        const [x1, y1, x2, y2] = det.bbox;
        drawBox(x1, y1, x2, y2, "#39ff14", `${Math.round(det.conf * 100)}%`);
      }

      rafRef.current = requestAnimationFrame(drawFrame);
    }

    rafRef.current = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [src, detections, fps, groundTruth]);

  const polypsFound = detections.filter((f) => f.length > 0).length;
  const totalFrames = detections.length;
  const detectionRate = totalFrames ? Math.round((polypsFound / totalFrames) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* Stats */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span className="text-gray-400">
          {t("Frames with polyp: {n} / {total}", { n: polypsFound, total: totalFrames })}
        </span>
        <span className="text-gray-400">
          {t("Detection rate: {rate}%", { rate: detectionRate })}
        </span>
        <span className="text-gray-400">
          {t("Resolution: {width}×{height}", { width, height })}
        </span>
      </div>

      {/* Video + canvas */}
      <div
        className="relative w-full rounded-xl overflow-hidden border border-gray-800 bg-black"
        style={{ aspectRatio: `${width}/${height}` }}
      >
        <video
          ref={videoRef}
          src={src}
          controls
          autoPlay
          loop
          muted
          className="absolute inset-0 w-full h-full"
        />
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium transition-colors w-16"
        >
          {playing ? t("Pause") : t("Play")}
        </button>
        <button
          onClick={handleStop}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-xs font-medium transition-colors"
        >
          {t("Stop")}
        </button>
        <span className="text-xs text-gray-500">{t("Speed")}</span>
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                speed === s
                  ? "bg-blue-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-gray-500 flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#39ff14" }} />
          {t("predicted")}
          {groundTruth ? (
            <>
              <span className="inline-block w-3 h-3 rounded-sm ml-1" style={{ background: "#22d3ee" }} />
              {t("ground truth")}
            </>
          ) : (
            <span className="text-gray-600 ml-1">{t("(no GT loaded)")}</span>
          )}
        </span>
      </div>
    </div>
  );
}
