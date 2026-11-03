# Agent map — polyp-detection

A file:line index of this repo. The point is to save an AI assistant (or a
human) from re-discovering "where is X" from scratch every session — look
here first, before searching the whole repo.

Two parts:
- **Subsystems** below is written by hand. It only needs updating when the
  architecture actually changes (a new subsystem, a file moving between
  them) — not on every commit.
- **Full listing** is produced by `documents/generate_agent_map.py`. Re-run
  it after adding/removing a route or a handful of components:

  ```
  python documents/generate_agent_map.py
  ```

  Don't hand-edit inside the `AUTO-GENERATED` markers — it gets overwritten
  on the next run. If the file:line references below look wrong, that's the
  sign to re-run the script, not to patch this file by hand.

## Subsystems (hand-maintained)

All backend routes are mounted under `/api` (see `backend/main.py`).

**Backend routes** (`backend/routes/`):
- **auth.py** — login/register/kiosk-login/logout/tutorials/me.
- **infer.py** — case/session lifecycle, plus the two live-inference
  websockets (camera vs. file-replay).
- **feedback.py** — clinical feedback capture, review queue, labeling.
- **recordings.py** — session recording start/chunk/stop/list/download.
- **spectate.py** — spectator room stats + websocket broadcast.
- **diagnostics.py** — clinic-test diagnostic reports.

**Backend services** (`backend/services/`):
- **engine.py** — picks Modal-GPU vs. local-CPU backend.
- **local_cpu.py** — onnxruntime local inference (RT-DETR decode, NMS, predict/bind).
- **modal_client.py** — thin client to the separate Modal GPU deploy.
- **frame_gate.py** — noise/focus-quality filter bank (Tenengrad, Laplacian, DFT, wavelet, etc).
- **tracker.py** — temporal persistence gate. **bytetrack/** — vendored ByteTrack, third-party.
- **spectate_bus.py** — pub/sub + binary frame broadcast for the spectator websocket.
- **review_clips.py**, **video.py** — ffmpeg-backed clip/video helpers.

**Backend top-level** (`backend/`):
- **main.py** — app + CORS + router mounts + `/health`.
- **auth.py** — password hash/verify, session cookies, role checks.
- **accounts.py** — grants/capabilities, admin audit log.
- **db.py** — sqlite connection + schema + `log_event` (the feedback DB).
- **scripts/** — one-off maintenance (manifest export/migrate, orphan recovery, stale-recording finalize). Run manually, not part of the live app.

**Frontend** (`frontend/src/`), grouped by subsystem:
- Players/session: `RealtimePlayer.tsx`, `LiveCameraPlayer.tsx`, `VideoPlayer.tsx`, `ReplaySurface.tsx`, `UploadPanel.tsx`, `DemoVideoPicker.tsx`, `WarmupPanel.tsx`.
- Feedback/review: `FeedbackPanel.tsx`, `ReviewCallout.tsx`, `CaptureStrip.tsx`, `CaptureSimulator.tsx`, `ScoreChips.tsx`.
- Recording: `RecordingControls.tsx`, `RecordingsPanel.tsx`, `RecordingRecoveryBanner.tsx`, `useSessionRecorder.ts`, `chunkStore.ts`.
- Picture pipeline / gates: `deinterlaceGL.ts`, `interlace.ts`, `enhance.ts`/`enhanceGL.ts`, `procAmp.ts`, `cameraMode.ts`, `fov.ts`, `frameQuality.ts`, `*GateNotice.tsx`, `use*Gate.ts`.
- Alerts: `AlertSoundControls.tsx`, `alertSound.ts`, `useAlertSound.ts`, `alertEpisodeGate.ts`.
- Auth/i18n: `LoginPanel.tsx`, `SignInPrompt.tsx`, `auth.tsx`, `i18n.tsx`, `translations.ts`.
- Diagnostics: `ClinicTest.tsx`, `clinicDiagnostic.ts`, `encoderPreview.ts`, `LatencyHud.tsx`.
- Doctor/presenter view: `DoctorScreen.tsx`, `useDoctorWindow.ts`, `SessionTimeline.tsx`, `OnScreenKeyboard.tsx`.
- Model perf: `ModelComparison.tsx`, `ModelPerformance.tsx`, `modelResults.ts`.

`frontend/src/lib/modelResults.ts` is ~12.5k lines of generated benchmark
data, not logic — grep for a specific model key rather than opening it.

**`inference/`** is a separate Modal deploy (`modal deploy inference/app.py`),
not part of the backend above.

## Full listing (auto-generated — do not hand-edit below this point)

<!-- AUTO-GENERATED START -->

### Backend routes

- `POST /login` — `backend/routes/auth.py:71`
- `POST /register` — `backend/routes/auth.py:100`
- `POST /kiosk-login` — `backend/routes/auth.py:112`
- `POST /logout` — `backend/routes/auth.py:127`
- `GET /tutorials` — `backend/routes/auth.py:162`
- `GET /me` — `backend/routes/auth.py:173`
- `GET /diagnostics/ping` — `backend/routes/diagnostics.py:67`
- `POST /diagnostics/net-test` — `backend/routes/diagnostics.py:74`
- `POST /diagnostics/reports` — `backend/routes/diagnostics.py:88`
- `PUT /diagnostics/reports/{report_id}/frames/{seq}` — `backend/routes/diagnostics.py:130`
- `PUT /diagnostics/reports/{report_id}/clip` — `backend/routes/diagnostics.py:160`
- `GET /diagnostics/reports/{report_id}/clip` — `backend/routes/diagnostics.py:187`
- `GET /diagnostics/reports` — `backend/routes/diagnostics.py:196`
- `GET /diagnostics/reports/{report_id}` — `backend/routes/diagnostics.py:233`
- `GET /diagnostics/reports/{report_id}/frames/{seq}` — `backend/routes/diagnostics.py:241`
- `POST /feedback/{case_id}/auto-capture` — `backend/routes/feedback.py:271`
- `POST /feedback/{case_id}/dr-found/capture` — `backend/routes/feedback.py:300`
- `GET /feedback/queue` — `backend/routes/feedback.py:337`
- `POST /feedback/{case_id}/{filename}/review` — `backend/routes/feedback.py:363`
- `POST /feedback/{case_id}/{filename}/label` — `backend/routes/feedback.py:433`
- `GET /feedback/list` — `backend/routes/feedback.py:464`
- `GET /feedback/{case_id}/image/{filename}` — `backend/routes/feedback.py:495`
- `GET /feedback/{case_id}/video/{filename}` — `backend/routes/feedback.py:505`
- `GET /feedback/{case_id}/clip/{filename}` — `backend/routes/feedback.py:516`
- `DELETE /feedback/{case_id}/{filename}` — `backend/routes/feedback.py:528`
- `POST /case/new` — `backend/routes/infer.py:69`
- `GET /backends` — `backend/routes/infer.py:80`
- `POST /session/start` — `backend/routes/infer.py:90`
- `POST /session/stop` — `backend/routes/infer.py:118`
- `GET /sessions/active` — `backend/routes/infer.py:132`
- `POST /sessions/{case_id}/stop` — `backend/routes/infer.py:145`
- `POST /infer-video` — `backend/routes/infer.py:157`
- `WEBSOCKET /ws/infer` — `backend/routes/infer.py:339`
- `WEBSOCKET /ws/infer-file` — `backend/routes/infer.py:359`
- `POST /recordings/{case_id}/start` — `backend/routes/recordings.py:156`
- `PUT /recordings/{case_id}/{recording_id}/chunk` — `backend/routes/recordings.py:206`
- `POST /recordings/{case_id}/{recording_id}/stop` — `backend/routes/recordings.py:263`
- `GET /recordings` — `backend/routes/recordings.py:319`
- `GET /recordings/{case_id}/{recording_id}/video` — `backend/routes/recordings.py:343`
- `DELETE /recordings/{case_id}/{recording_id}` — `backend/routes/recordings.py:363`
- `POST /spectate/{case_id}/room-stats` — `backend/routes/spectate.py:40`
- `GET /spectate/rooms` — `backend/routes/spectate.py:73`
- `WEBSOCKET /ws/spectate/{case_id}` — `backend/routes/spectate.py:86`
- `backend/main.py` — see `@app.get(...)` lines directly

### Backend modules (top-level def/class)

- `backend/accounts.py` — lines 74, 78, 99, 106, 123, 139, 146, 156, 161, 184, 190, 196, 229, 246, 256, 265, 276
- `backend/auth.py` — lines 85, 102, 113, 131, 149, 158, 176, 187, 191, 223, 248, 253, 260, 306, 329, 377, 394, 398
- `backend/db.py` — lines 147, 151, 169, 182
- `backend/main.py` — lines 67
- `backend/routes/auth.py` — lines 26, 30, 40, 61, 72, 101, 113, 128, 163, 174
- `backend/routes/diagnostics.py` — lines 57, 62, 68, 75, 89, 131, 161, 188, 197, 234, 242
- `backend/routes/feedback.py` — lines 94, 99, 106, 118, 134, 139, 182, 193, 201, 208, 224, 233, 245, 259, 272, 301, 338, 364, 434, 465, 496, 506, 517, 529, 554
- `backend/routes/infer.py` — lines 43, 63, 70, 81, 91, 119, 133, 146, 158, 178, 242, 340, 360
- `backend/routes/recordings.py` — lines 96, 101, 106, 111, 121, 131, 135, 143, 157, 207, 264, 320, 344, 364
- `backend/routes/spectate.py` — lines 30, 41, 74, 87
- `backend/scripts/export_manifest.py` — lines 37
- `backend/scripts/finalize_stale_recordings.py` — lines 89, 101, 117, 155, 168, 172
- `backend/scripts/migrate_manifest_to_sqlite.py` — lines 47, 53, 60, 71
- `backend/scripts/recover_orphans.py` — lines 62, 76, 86
- `backend/scripts/reset_live_labels.py` — lines 60
- `backend/scripts/triage_recordings.py` — lines 116, 135
- `backend/services/bytetrack/basetrack.py` — lines 5, 12
- `backend/services/bytetrack/byte_tracker.py` — lines 8, 135, 282, 296, 307
- `backend/services/bytetrack/kalman_filter.py` — lines 23
- `backend/services/bytetrack/matching.py` — lines 9, 30, 47, 58, 72, 92, 113, 134, 151, 164, 178, 191
- `backend/services/engine.py` — lines 30, 34, 43, 55, 77, 81
- `backend/services/frame_gate.py` — lines 104, 140, 151, 158, 165, 169, 176, 180, 191, 202, 220, 244, 256, 266, 318
- `backend/services/local_cpu.py` — lines 103, 107, 139, 147, 164, 184, 208, 227, 239, 258, 281, 317, 334, 363, 389, 418, 451
- `backend/services/modal_client.py` — lines 11, 18, 22, 29
- `backend/services/review_clips.py` — lines 56
- `backend/services/spectate_bus.py` — lines 50, 64, 71, 78, 89, 103, 107, 113, 117, 126, 132, 142, 159
- `backend/services/tracker.py` — lines 46
- `backend/services/video.py` — lines 8, 20, 32

### Frontend exports

- `frontend/src/app/clinic-test/page.tsx` — lines 17
- `frontend/src/app/doctor-test/page.tsx` — lines 35
- `frontend/src/app/layout.tsx` — lines 7, 11
- `frontend/src/app/login/page.tsx` — lines 46
- `frontend/src/app/model-comparison/page.tsx` — lines 19
- `frontend/src/app/page.tsx` — lines 162
- `frontend/src/app/sim/page.tsx` — lines 16
- `frontend/src/app/spectator/[caseId]/page.tsx` — lines 114
- `frontend/src/app/spectator/page.tsx` — lines 24
- `frontend/src/app/tutorials/page.tsx` — lines 19
- `frontend/src/components/AlertSoundControls.tsx` — lines 12
- `frontend/src/components/CaptureSimulator.tsx` — lines 70
- `frontend/src/components/CaptureStrip.tsx` — lines 59, 74, 76, 94, 102, 145, 173, 351
- `frontend/src/components/ClinicTest.tsx` — lines 154
- `frontend/src/components/demos.ts` — lines 9
- `frontend/src/components/DemoVideoPicker.tsx` — lines 13
- `frontend/src/components/FeedbackPanel.tsx` — lines 120
- `frontend/src/components/FilterBankNotice.tsx` — lines 63
- `frontend/src/components/GpuStatusBar.tsx` — lines 22
- `frontend/src/components/InBodyGateNotice.tsx` — lines 12
- `frontend/src/components/LatencyHud.tsx` — lines 68
- `frontend/src/components/LiveCameraPlayer.tsx` — lines 358
- `frontend/src/components/LoginPanel.tsx` — lines 28
- `frontend/src/components/ModelComparison.tsx` — lines 42
- `frontend/src/components/ModelPerformance.tsx` — lines 20
- `frontend/src/components/OnScreenKeyboard.tsx` — lines 26
- `frontend/src/components/QualityGateNotice.tsx` — lines 33
- `frontend/src/components/RealtimePlayer.tsx` — lines 132
- `frontend/src/components/RecordingControls.tsx` — lines 25, 34, 55
- `frontend/src/components/RecordingRecoveryBanner.tsx` — lines 30
- `frontend/src/components/RecordingsPanel.tsx` — lines 48
- `frontend/src/components/ReplaySurface.tsx` — lines 39
- `frontend/src/components/ReviewCallout.tsx` — lines 28
- `frontend/src/components/ScoreChips.tsx` — lines 19
- `frontend/src/components/SessionTimeline.tsx` — lines 40
- `frontend/src/components/SignInPrompt.tsx` — lines 16, 21
- `frontend/src/components/TemporalGateNotice.tsx` — lines 30
- `frontend/src/components/TutorialsPanel.tsx` — lines 21
- `frontend/src/components/UploadPanel.tsx` — lines 14
- `frontend/src/components/VideoPlayer.tsx` — lines 26
- `frontend/src/components/WarmupPanel.tsx` — lines 27
- `frontend/src/lib/alertEpisodeGate.ts` — lines 31
- `frontend/src/lib/alertSound.ts` — lines 38
- `frontend/src/lib/auth.tsx` — lines 123, 281
- `frontend/src/lib/cameraMode.ts` — lines 55, 101, 126, 297
- `frontend/src/lib/clinicDiagnostic.ts` — lines 25, 32, 686
- `frontend/src/lib/deinterlaceGL.ts` — lines 33, 176
- `frontend/src/lib/drawBoxes.ts` — lines 10
- `frontend/src/lib/enhance.ts` — lines 44
- `frontend/src/lib/enhanceGL.ts` — lines 119
- `frontend/src/lib/fonts.ts` — lines 3
- `frontend/src/lib/fov.ts` — lines 87, 108, 173, 188, 199
- `frontend/src/lib/frameQuality.ts` — lines 45, 53, 55, 130, 184
- `frontend/src/lib/frameRing.ts` — lines 57, 61, 73
- `frontend/src/lib/gateDefaults.ts` — lines 26
- `frontend/src/lib/i18n.tsx` — lines 14, 64
- `frontend/src/lib/inBody.ts` — lines 113, 191, 230, 372
- `frontend/src/lib/interlace.ts` — lines 57, 70, 118, 187
- `frontend/src/lib/modelResults.ts` — lines 84, 12526, 12527, 12530, 12531, 12532
- `frontend/src/lib/procAmp.ts` — lines 25, 41, 48
- `frontend/src/lib/rolling.ts` — lines 55
- `frontend/src/lib/temporal.ts` — lines 33, 40, 53, 56, 72
- `frontend/src/lib/translations.ts` — lines 3
- `frontend/src/lib/uploadCoordinator.ts` — lines 31, 46
- `frontend/src/lib/useAlertSound.ts` — lines 23, 24, 29, 30, 45
- `frontend/src/lib/useDoctorWindow.ts` — lines 51, 57, 122, 143, 255, 262
- `frontend/src/lib/useDurationFix.ts` — lines 13
- `frontend/src/lib/useFullscreen.ts` — lines 23, 82, 84, 98
- `frontend/src/lib/useInBodyGate.ts` — lines 47
- `frontend/src/lib/useQualityGate.ts` — lines 47
- `frontend/src/lib/useRollingClip.ts` — lines 18
- `frontend/src/lib/useSessionRecorder.ts` — lines 55, 65, 66, 70, 78, 85, 204, 217
- `frontend/src/lib/useTemporalGate.ts` — lines 28

### Inference (separate Modal deploy)

- `inference/app.py` — lines 64
- `inference/model.py` — lines 14
- `inference/train.py` — lines 39, 147

<!-- AUTO-GENERATED END -->
