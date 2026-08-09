"use client";

import { useEffect, useRef } from "react";

const CHUNK_MS = 1000;
const MAX_CHUNKS = 8; // ~8s rolling window

/** Keeps a short rolling video buffer of a <video> element's own playback
 * (via captureStream), so a capture action can attach "what led up to this
 * moment" as a short clip, not just a still frame. Best-effort: if the
 * browser can't captureStream/record (older Safari etc.), clips are simply
 * unavailable and captures still work fine with just the image. */
export function useRollingClip(video: HTMLVideoElement | null) {
  const chunksRef = useRef<Blob[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (!video) return;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    try {
      // @ts-expect-error captureStream isn't in the older lib.dom typings
      stream = typeof video.captureStream === "function" ? video.captureStream() : null;
      if (!stream || !("MediaRecorder" in window)) return;
      const mimeType = ["video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        chunksRef.current.push(e.data);
        if (chunksRef.current.length > MAX_CHUNKS) chunksRef.current.shift();
      };
      recorder.start(CHUNK_MS);
      recorderRef.current = recorder;
    } catch {
      // captureStream/MediaRecorder unsupported or blocked — clips just won't be available
    }
    return () => {
      try { recorder?.stop(); } catch { /* already stopped */ }
      chunksRef.current = [];
    };
  }, [video]);

  /** Current rolling buffer as one clip, or null if nothing's been recorded
   * yet / recording isn't supported in this browser. */
  function getClip(): Blob | null {
    if (chunksRef.current.length === 0) return null;
    return new Blob(chunksRef.current, { type: "video/webm" });
  }

  return { getClip };
}
