# Decisions

One line per topic, Y-statement format: "In the context of [use case],
facing [concern], we decided [option] to achieve [quality], accepting
[downside]." Full reasoning and benchmark data live in documents/adr/.

## Video-labeling propagation engine

In the context of backward box propagation for the video-labeling platform on noormind-iran, facing a choice between optical-flow tracking and SAM2 video segmentation now that the box has a GPU (RTX A2000, added 2026-09-27), we decided to keep optical flow (Median Flow / LK) as the default and only propagation engine, to achieve fast (~11ms/frame) dependency-light propagation that is never less accurate than SAM2 on this footage, accepting that SAM2's better persistence through occluded/hard stretches stays available only as an unused-by-default manual fallback (documents/adr/0001-propagation-engine-flow-vs-sam2.md).

## Tier 3 alert now fires on capture, not its own timer

In the context of the three-tier live-inference response (box, capture,
alert) on noormind-iran, facing an alert bar that was harder to clear than
the already-infrequent capture bar and so rarely fired even when a capture
was filed, we decided to make tier 3 fire whenever tier 2 files a capture
(dropping the independent ALERT_MIN_MS/ALERT_MIN_CONF gate) to achieve a
beep for every captured image, accepting that if a future model raises
capture volume back up, tier 3 gets noisy again automatically since it now
equals tier 2 (documents/adr/0002-capture-also-alerts.md).
