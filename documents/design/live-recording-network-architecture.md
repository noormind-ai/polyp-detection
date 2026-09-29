# Live session recording: durable storage, bandwidth arbitration, in-body auto-toggle, review clips — design

Goal: fix four real gaps in the live procedure's session-recording feature
(`useSessionRecorder.ts` / `backend/routes/recordings.py`), found while
tracing exactly how video capture works end to end during a live procedure.
This is about the *live* recording pipeline, not the offline lesion-labeling
platform (`video-label/`, see `video-label/documents/` for that design).

> **Revised after real usage surfaced two gaps in the first version of this
> design** (kept sections 4 and 5 below current rather than adding a second,
> separate doc): section 4's "upload only after Stop" and section 5's
> "every out-of-body moment is a brief withdrawal" have both been replaced.
> See the callouts inline.

---

## 1. Problems

**Buffer lives only in RAM.** Recording chunks are held in a plain JS array
(`bufferRef.current`) for the whole procedure and only uploaded after Stop.
A crashed tab, an OOM, or a power loss before Stop loses the entire
procedure's video, silently — there is no local copy anywhere.

**No guard against the next procedure's contention.** The buffer-then-upload
design exists specifically so recording upload doesn't compete with live
inference frames on the same slow uplink (~100 KB/s on this deployment).
But that upload can take ~5 minutes after Stop, and nothing stops a second
procedure starting 3 minutes later in the same tab from having its own live
inference frames queued behind the first procedure's still-draining upload —
exactly the contention this design was meant to avoid.

**Recording is fully manual.** It should default to ON while the scope is
inside the body and OFF outside, to avoid storing irrelevant footage, while
always leaving a manual override available to the operator.

**No path from a flagged event to a watchable clip.** `backend/routes/feedback.py`
already stores `recording_id` + `video_offset_ms` per capture, but nothing
turns that into a playable clip — a reviewer has to manually find the right
recording and scrub to a timestamp by hand.

---

## 2. Design principle

This is the same problem NVR/dashcam systems solve: **record durably at the
edge first, treat the network as a lazy, best-effort sync, and never let the
archival channel compete with the latency-sensitive one.** A hybrid
edge-plus-cloud NVR records continuously on-site and uploads selectively,
riding through outages because the local copy is authoritative, not the
upload ([Recording and Live Streaming IP Surveillance Video, Part 1: Edge
Storage](https://www.ipphone-warehouse.com/blog/recording-and-live-streaming-ip-surveillance-video-part-1-edge-storage/);
[The Best Cloud NVR Setup Is Usually a Hybrid, Not Pure
Cloud](https://safesandsecuritysolutions.com/blogs/news/best-cloud-nvr);
[Cloud & Hybrid Surveillance Storage: Cost &
Bandwidth](https://www.forasoft.com/learn/video-surveillance/articles-vms/cloud-hybrid-storage-for-surveillance)).

Browser-side, the equivalent of "record at the edge" is writing chunks to a
durable local store (OPFS/IndexedDB) as they're produced, not a JS variable —
the same pattern upload tools use to survive a browser crash mid-upload
([The Golden Retriever: Making uploads survive browser crashes
(Uppy)](https://uppy.io/blog/2017/07/golden-retriever/);
[Resumable.js](https://www.resumablejs.com/); [Offline Recovery for Browser
Uploads Without False
Promises](https://dev.to/gathmo/offline-recovery-for-browser-uploads-without-false-promises-5371)).

---

## 3. Durable local storage (replaces the RAM buffer)

`frontend/src/lib/chunkStore.ts` — a storage abstraction picking the best
durable backend available, in order: **OPFS → IndexedDB → in-memory (visibly
flagged, never silent)**.

- **OPFS**: `navigator.storage.getDirectory()` → one subdirectory per
  `recording_id`, one file per chunk (`000000.chunk`, …) plus a `meta.json`
  sidecar. Survives a crashed tab or renderer by construction.
- **IndexedDB fallback**: one object store keyed `[recordingId, seq]`, for
  browsers without a usable OPFS write API.
- **Memory fallback**: today's exact behavior for browsers with neither —
  but the UI now says so explicitly (`RecordingControls.tsx` shows a warning
  when `storageKind === "memory"`), rather than silently pretending a RAM
  buffer is as safe as the other two.

Worst case on a crash: the last unflushed slice (a few seconds), not the
whole procedure.

**Crash recovery (minimum viable):** on mount, check for an orphaned
recording directory/DB entry that the server doesn't already have marked
`complete`, and offer to resume its upload, download it locally, or discard
it. See section 4's revision below for how much smaller this window usually
is now that upload isn't deferred entirely to Stop.

**Current capture settings**, since they size everything below: the
recording requests 1280×720 from the camera (`getUserMedia`'s
`width/height: {ideal}`), at whatever native frame rate the camera provides
(no cap set — typically 30fps), encoded by `MediaRecorder` at 1.2 Mbps
(`VIDEO_BITS_PER_SECOND`). Inference frames are a separate, much smaller
pipeline — each downscaled to 320px wide before being sent for detection;
not what gets recorded. At 1.2 Mbps and a 3-second `MediaRecorder` timeslice
(`CHUNK_MS`), each chunk is ~450 KB — against the ~100 KB/s clinic uplink
referenced above, one chunk takes ~4.5s to actually clear the link.

---

## 4. Not competing with the next procedure — REVISED: also uploads opportunistically, not only after Stop

**Original version of this section said upload happens only after Stop, and
the bandwidth-arbitration signal covered the whole live session.** Real usage
showed the second half of that was too coarse: a live session marks the link
"busy" for its *entire* duration in the original design, including
out-of-body stretches where the loop never actually calls `ws.send` at all —
exactly when the link is genuinely free. That meant a still-uploading
recording (this session's own paused one, or a leftover from the previous
patient) waited for the whole session to end, not just for frames to stop
flowing.

**Revised design:**

- `frontend/src/lib/uploadCoordinator.ts`'s API is unchanged
  (`beginLiveInference()`/its returned release, `isLiveInferenceActive()`,
  `waitUntilInferenceIdle()`) — what changed is *when* `LiveCameraPlayer.tsx`
  calls it. Instead of one hold for the whole `startLoop()` call, the hold is
  acquired/released on each in-body ⇄ out-of-body transition (the same
  transition tracking `applyAutoRecord` already does for pause/resume/stop —
  see section 5): acquired the moment frames start flowing, released the
  moment they stop. A safety-net release exists at loop-end and on unmount so
  a hold is never leaked if the loop stops while still marked "inside".
- Upload is no longer deferred entirely to Stop. `useSessionRecorder.ts`'s
  `pause()` fires an opportunistic **trickle upload** (`uploadPending(id)`)
  the moment it pauses — this is very possibly an out-of-body stretch, during
  which the link is actually idle. `uploadPending` uploads whatever's
  currently in durable storage that hasn't been sent yet (tracked by
  `nextUploadSeqRef`, a plain count since chunks always upload in order),
  chained through `uploadChainRef` so overlapping calls (a trickle still
  running when Stop is pressed) queue instead of racing. `finalize()` (Stop)
  now just calls the same `uploadPending()` to drain whatever's left, instead
  of its own separate upload loop starting from zero.
- Each chunk still individually waits on `waitUntilInferenceIdle()` inside
  `putChunk` before sending — now correctly gated on "are frames actually
  flowing", so a chunk that starts sending in a genuine idle window is not
  blocked, and one queued behind actively-flowing frames still waits.
  Already-in-flight PUTs are left to finish naturally if frames resume before
  they complete — consistent with the existing philosophy of checking before
  a send starts rather than aborting one mid-flight.
- `backend/routes/recordings.py`'s strict-sequential chunk ordering is still
  untouched — chunks still arrive in order, just possibly spread across
  several opportunistic bursts during the procedure instead of one burst at
  the end. Still zero backend changes.
- Each procedure room is still a separate browser tab/device, so no
  cross-tab or cross-device coordination is needed.

**Practical effect on crash exposure (section 3):** most of a procedure's
video now reaches the server incrementally at each natural pause, not only
at the very end — shrinking the at-risk "only in local durable storage, not
yet on the server" window to whatever's accumulated since the last trickle,
rather than the whole procedure.

**Visibility:** `RecordingControls.tsx`'s upload-progress readout
(`uploadedChunks`/`totalChunks`/`waitingForLink` on `SessionRecorder`) now
shows whenever upload is actually behind (`totalChunks > 0 && uploadedChunks
< totalChunks`), not only while `status === "stopping"` — so a trickle
upload during a mid-procedure pause is visible, not just the final drain.
`RecordingsPanel.tsx`'s Saved Recordings list (already polling every 10s
while a recording is open) also shows a running chunk count per row, so an
open recording's progress is visible from that list too, not only from the
current session's own indicator.

---

## 5. Auto on/off tied to in-body/out-of-body — REVISED: a 5-second threshold splits "pause" from "patient changed"

**Original version of this section treated every out-of-body moment as a
brief, same-patient withdrawal that resumes the same recording.** Real usage
doesn't work that way: a doctor finishes one patient, pulls the scope out,
and starts the next patient several minutes later — nobody touches
Start/Stop in between. The original design couldn't tell "brief
repositioning" from "patient changed", so it would have silently resumed the
*same* recording for the next patient, concatenating two different patients'
footage into one video file.

**Revised design — confirmed with the user: under 5 seconds out-of-body is
"just a brief withdrawal"; at or past that, treat it as the procedure ending:**

- `LiveCameraPlayer.tsx`'s `applyAutoRecord` tracks how long the current
  out-of-body stretch has lasted (`outsideStartRef`, set on the
  inside→outside transition). Under `OUT_OF_BODY_STOP_MS = 5000`, behavior is
  unchanged from the original design: pause, ready to resume the same
  recording the moment the scope goes back in.
- At or past 5 seconds, `recorder.stop()` fires once per excursion
  (`autoStoppedRef` guards against firing more than once) instead of leaving
  it paused — finalizing and uploading that recording exactly as a manual
  Stop would. Going back in-body afterward auto-**starts a fresh recording**
  through the same auto-start path this feature already has for "nothing is
  currently active" — no separate code path needed for that half of it.
- The in/out-of-body signal itself (`frontend/src/lib/inBody.ts`) is
  unchanged from the original design — already properly debounced (EMA-
  smoothed probability, asymmetric enter/exit thresholds, a dwell streak
  before flipping), so this doesn't add a second debounce layer on top of it.
- The manual override still holds until the next real transition, then
  reverts to auto — chosen over "sticks for the rest of the procedure" to
  limit the risk of a forgotten manual-off silently leaving the rest of a
  long procedure unrecorded.
- The auto-toggle's own on/off kill switch is **not persisted** across
  sessions (localStorage) — an earlier version of this feature did persist it
  the way `useInBodyGate`'s switch is, which created a real deadlock (see
  `useSessionRecorder.ts`/`LiveCameraPlayer.tsx` comments): the switch also
  gates the very first auto-**start** of a recording, and its own checkbox
  only rendered once a recording was already active, so a browser where it
  was ever switched off had no way back to on. It now defaults fresh to on
  every mount, with the checkbox always visible (not just while recording).
- Pausing/resuming a `MediaRecorder` mid-session still means the recorded
  video is shorter than wall-clock elapsed time. Feedback-capture offsets
  (`mark()`) are still computed from accumulated *recorded* time, not wall
  clock, so they stay accurate against the actual (gapped) video — unchanged
  by this revision.

---

## 6. Server-side review clips

Once a recording completes, and for every feedback capture that references
it, the server cuts a short clip (~5s each side of `video_offset_ms`) with
ffmpeg and serves it back. `FeedbackPanel.tsx` plays it inline in place of
today's plain-text timestamp label, falling back to that label if a clip
isn't ready yet. This removes the manual "find the recording, scrub to the
timestamp" step entirely for the common case.

---

## Open questions

- No push/poll exists to tell an already-open review queue that a clip just
  finished generating — a manual refresh is needed today. Flagged as later
  polish, not solved here.
- The durable-storage crash-recovery UI is a minimum viable version (list,
  offer upload/download/discard) — a fuller "resume automatically without
  asking" flow is possible later if this turns out to be needed often.
- Segmenting `recordings.py`'s storage into independent, out-of-order/
  parallel-uploadable chunks (instead of one strictly-sequential growing
  file) would make the upload pipeline more robust, but was deliberately
  left out of this round — not requested, and the contention fix above
  needs no backend change at all.
- The 5-second out-of-body threshold (section 5) is a single global constant,
  not per-operator or per-procedure-type tunable. If real usage shows
  repositioning routinely takes longer than 5s (falsely triggering a
  "patient changed" stop) or patient changes routinely happen faster than 5s
  (falsely staying in the same recording), this is the first knob to revisit.
- The per-video status shown in `RecordingsPanel.tsx` (section 4) is
  "chunks received so far", not "N of M" — the server has no way to know the
  eventual total until Stop is called, so an open recording's progress reads
  as an open-ended counter, not a completion percentage.
