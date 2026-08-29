"use client";

import { useEffect } from "react";

/**
 * A WebM written by MediaRecorder in streaming mode carries no duration in its
 * header, so the browser reports Infinity and the seek bar is dead. Seeking
 * absurdly far past the end forces it to scan to the last cluster and resolve
 * the real duration; then we put the playhead back at the start. Without this,
 * playback works but scrubbing does not — which is most of the point of having
 * the recording at all.
 */
export function useDurationFix(video: HTMLVideoElement | null) {
  useEffect(() => {
    if (!video) return;
    let scanning = false;

    const onMeta = () => {
      if (scanning || Number.isFinite(video.duration)) return;
      scanning = true;
      video.currentTime = 1e101;
    };

    // Keyed on durationchange rather than on seeked. A seeked event cannot be
    // told apart from one the viewer caused, so watching for it meant a scrub
    // that landed while the scan was still running got yanked back to zero —
    // which is exactly when someone is most likely to grab the scrub bar.
    // durationchange fires once, when the scan teaches the browser the real
    // length, and clearing the flag before restoring the playhead means every
    // later seek is left alone.
    const onDurationChange = () => {
      if (!scanning || !Number.isFinite(video.duration)) return;
      scanning = false;
      video.currentTime = 0;
      video.removeEventListener("durationchange", onDurationChange);
    };

    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onDurationChange);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onDurationChange);
    };
  }, [video]);
}
