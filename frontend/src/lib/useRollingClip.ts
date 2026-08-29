"use client";

import { useEffect, useRef } from "react";

const CHUNK_MS = 1000;
const MAX_CHUNKS = 8; // ~8s rolling window
// MediaRecorder defaults to a bitrate scaled to the source resolution, which
// produced ~2.5 MB for an 8s clip off a 720p camera. A review clip only has to
// show what led up to the frame; 500 kbps is plenty and it is 6x less to push
// up a clinic uplink that is simultaneously streaming frames for inference.
const CLIP_BITS_PER_SECOND = 500_000;

/** Keeps a short rolling video buffer of a <video> element's own playback
 * (via captureStream), so a capture action can attach "what led up to this
 * moment" as a short clip, not just a still frame. Best-effort: if the
 * browser can't captureStream/record (older Safari etc.), clips are simply
 * unavailable and captures still work fine with just the image. */
export function useRollingClip(video: HTMLVideoElement | null) {
  const chunksRef = useRef<Blob[]>([]);
  // MediaRecorder puts the EBML/WebM header and the codec init segment in the
  // FIRST blob it emits; every later blob is a bare cluster. The rolling window
  // used to shift that first blob out after MAX_CHUNKS seconds, so any clip
  // captured more than ~8s into a session was a headerless stream — saved fine,
  // played nowhere ("EBML header parsing failed"). Hold the header aside and
  // roll only the clusters behind it.
  const headerRef = useRef<Blob | null>(null);
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
      const opts: MediaRecorderOptions = { videoBitsPerSecond: CLIP_BITS_PER_SECOND };
      if (mimeType) opts.mimeType = mimeType;
      recorder = new MediaRecorder(stream, opts);
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        if (!headerRef.current) { headerRef.current = e.data; return; }
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
      headerRef.current = null;
    };
  }, [video]);

  /** Current rolling buffer as one clip, or null if nothing's been recorded
   * yet / recording isn't supported in this browser. */
  function getClip(): Blob | null {
    if (!headerRef.current || chunksRef.current.length === 0) return null;
    return new Blob([headerRef.current, ...chunksRef.current], { type: "video/webm" });
  }

  return { getClip };
}
