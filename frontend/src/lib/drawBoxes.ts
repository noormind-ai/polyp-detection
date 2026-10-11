export interface Box { bbox: [number, number, number, number]; conf: number; }

/** Draws `source` into `canvas` then burns in a box + confidence label per
 *  detection, in the neon-green house style used everywhere a live detection
 *  is shown. Extracted out of LiveCameraPlayer's drawAnalyzedFrame so the
 *  room view and the spectator view (spectator/[caseId]/page.tsx) render
 *  boxes identically from one implementation instead of two that can drift
 *  apart. `label` is injected rather than hardcoded so each caller can run
 *  its own translation function. */
export function drawBoxes(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource & { width: number; height: number },
  boxes: Box[],
  label: (box: Box) => string,
): void {
  if (canvas.width !== source.width) canvas.width = source.width;
  if (canvas.height !== source.height) canvas.height = source.height;

  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0);

  for (const det of boxes) {
    const [x1, y1, x2, y2] = det.bbox;
    ctx.shadowColor = "#39ff14";
    ctx.shadowBlur = 10;
    ctx.strokeStyle = "#39ff14";
    ctx.lineWidth = 3;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.shadowBlur = 0;
    const text = label(det);
    ctx.font = "bold 13px monospace";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "#39ff14";
    ctx.fillRect(x1, y1 - 20, tw + 8, 20);
    ctx.fillStyle = "#000";
    ctx.fillText(text, x1 + 4, y1 - 5);
  }
}
